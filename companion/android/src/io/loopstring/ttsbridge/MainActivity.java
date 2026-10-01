package io.loopstring.ttsbridge;

import android.app.Activity;
import android.os.Bundle;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import android.util.Log;
import android.widget.ScrollView;
import android.widget.TextView;

import java.io.BufferedOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * A loopback HTTP bridge to Android's native TextToSpeech.
 *
 * Exists because Obsidian's Android WebView exposes no speech API at all:
 * window.speechSynthesis is undefined and its Capacitor bridge compiles in no
 * TextToSpeech plugin. Measured on a Pixel 9 Pro XL, Chromium 154 WebView.
 * The WebView *can* reach http://127.0.0.1, which is the one door left open.
 */
public class MainActivity extends Activity implements TextToSpeech.OnInitListener {

    private static final String TAG = "TtsBridge";
    private static final int PORT = 8787;
    /**
     * Hard caps on what an unauthenticated client can make us hold. Without
     * them one request with no token and "Content-Length: 2000000000" killed
     * the process: the body buffer was allocated before the token check, and
     * the OutOfMemoryError escaped the per-connection catch.
     */
    private static final int MAX_HEADER_BYTES = 16 * 1024;
    private static final int MAX_BODY_BYTES = 64 * 1024;

    private volatile TextToSpeech tts;
    private volatile boolean ttsReady = false;
    private String token;
    private TextView out;
    private final AtomicInteger seq = new AtomicInteger();
    /** synthesizeToFile is async and single-tracked; serialise callers. */
    private final Object synthLock = new Object();

    // Per-utterance completion plumbing.
    private volatile CountDownLatch done;
    private volatile String wantId;
    private volatile boolean failed;
    private volatile List<int[]> ranges;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        byte[] r = new byte[16];
        new SecureRandom().nextBytes(r);
        StringBuilder sb = new StringBuilder();
        for (byte x : r) sb.append(String.format("%02x", x));
        token = sb.toString();

        out = new TextView(this);
        out.setTextSize(13f);
        out.setPadding(28, 56, 28, 28);
        ScrollView sv = new ScrollView(this);
        sv.addView(out);
        setContentView(sv);

        // Printed to logcat on purpose: it is how an automated test reads the
        // token without screen-scraping. A shipped build would not do this.
        Log.i(TAG, "TOKEN=" + token);
        log("TTS Bridge\n\nPort: " + PORT + " (127.0.0.1 only)\nToken: " + token + "\n");

        tts = new TextToSpeech(this, this);

        tts.setOnUtteranceProgressListener(new Tap(this));

        new Thread(this::serve, "tts-bridge-http").start();
    }

    private void log(String s) {
        Log.i(TAG, s.replace('\n', ' '));
        runOnUiThread(() -> out.append(s + "\n"));
    }

    private void serve() {
        // An explicit IPv4 loopback, never InetAddress.getLoopbackAddress():
        // on Android 17 that returned ::1, so the socket sat in /proc/net/tcp6
        // and a client calling http://127.0.0.1 (what the plugin and every doc
        // use) was refused, by WebView fetch and CapacitorHttp alike.
        InetAddress lo;
        try {
            lo = InetAddress.getByAddress(new byte[] {127, 0, 0, 1});
        } catch (IOException e) {
            log("bind FAILED: " + e.getClass().getSimpleName());
            return;
        }
        try (ServerSocket ss = new ServerSocket(PORT, 8, lo)) {
            // The address actually bound, not a literal: the old hardcoded
            // "127.0.0.1" stayed in the log while the socket was on ::1.
            log("listening on " + ss.getLocalSocketAddress());
            while (!Thread.currentThread().isInterrupted()) {
                try (Socket c = ss.accept()) { handle(c); }
                // Throwable, not Exception. An Error from one connection must
                // not take the accept thread, and with it the process, down.
                // Class name only: an exception message can echo client input.
                catch (Throwable t) { Log.w(TAG, "conn: " + t.getClass().getSimpleName()); }
            }
        } catch (IOException e) {
            log("bind FAILED: " + e.getClass().getSimpleName());
        }
    }

    private void handle(Socket c) throws Exception {
        InputStream in = c.getInputStream();
        OutputStream raw = c.getOutputStream();
        BufferedOutputStream os = new BufferedOutputStream(raw);

        // Request line + headers, capped so a client cannot grow this without
        // bound by never sending the blank line.
        StringBuilder head = new StringBuilder();
        int cur;
        while ((cur = in.read()) != -1) {
            head.append((char) cur);
            if (head.length() > MAX_HEADER_BYTES) {
                send(os, 431, "text/plain", "headers too large".getBytes(), null); return;
            }
            if (head.length() >= 4 && head.charAt(head.length()-1)=='\n'
                && head.charAt(head.length()-2)=='\r' && head.charAt(head.length()-3)=='\n'
                && head.charAt(head.length()-4)=='\r') break;
        }
        String[] lines = head.toString().split("\r\n");
        if (lines.length == 0) return;
        String[] rl = lines[0].split(" ");
        if (rl.length < 2) { send(os, 400, "text/plain", "bad request".getBytes(), null); return; }
        String method = rl[0], target = rl[1];
        long clen = 0; boolean badLen = false; String auth = "";
        for (String h : lines) {
            String lower = h.toLowerCase(Locale.ROOT);
            if (lower.startsWith("content-length:")) {
                try { clen = Long.parseLong(h.split(":",2)[1].trim()); }
                catch (NumberFormatException e) { badLen = true; }
            }
            if (lower.startsWith("authorization:")) auth = h.split(":",2)[1].trim();
        }

        String path = target.contains("?") ? target.substring(0, target.indexOf('?')) : target;
        String query = target.contains("?") ? target.substring(target.indexOf('?')+1) : "";

        if (path.equals("/health")) {
            send(os, 200, "application/json",
                ("{\"ok\":true,\"ttsReady\":" + ttsReady + ",\"engine\":\""
                 + (ttsReady ? tts.getDefaultEngine() : "") + "\",\"port\":" + PORT + "}")
                .getBytes(StandardCharsets.UTF_8), null);
            return;
        }

        // Everything below needs the token.
        if (!auth.equals("Bearer " + token) && !query.contains("token=" + token)) {
            send(os, 401, "text/plain", "unauthorized".getBytes(), null); return;
        }

        // The body is read only now, after the token check and inside a cap.
        // A plugin chunk is a few hundred characters; 64 KiB is generous.
        if (badLen || clen < 0) { send(os, 400, "text/plain", "bad content-length".getBytes(), null); return; }
        if (clen > MAX_BODY_BYTES) { send(os, 413, "text/plain", "body too large".getBytes(), null); return; }
        byte[] body = new byte[(int) clen];
        int got = 0; while (got < clen) { int k = in.read(body, got, (int) clen - got); if (k < 0) break; got += k; }


        if (path.equals("/engines")) {
            StringBuilder j = new StringBuilder("{\"current\":\"" + (ttsReady ? tts.getDefaultEngine() : "") + "\",\"available\":[");
            boolean f2 = true;
            if (ttsReady && tts.getEngines() != null) {
                for (TextToSpeech.EngineInfo e : tts.getEngines()) {
                    if (!f2) j.append(","); f2 = false;
                    j.append("{\"name\":\"").append(e.name).append("\",\"label\":\"").append(e.label).append("\"}");
                }
            }
            j.append("]}");
            send(os, 200, "application/json", j.toString().getBytes(StandardCharsets.UTF_8), null);
            return;
        }

        // Rebind to a named engine WITHOUT touching system settings. Writing
        // secure tts_default_synth did not switch engines on this device
        // (tts_enabled_plugins is null), so the three-arg TextToSpeech
        // constructor is the only route a plugin-side app actually controls.
        if (path.equals("/setengine")) {
            String pkg = "";
            for (String kv : query.split("&")) if (kv.startsWith("engine=")) pkg = kv.substring(7);
            if (pkg.isEmpty()) { send(os, 400, "text/plain", "engine= required".getBytes(), null); return; }
            final CountDownLatch ready = new CountDownLatch(1);
            final boolean[] ok = {false};
            TextToSpeech old = tts;
            TextToSpeech fresh = new TextToSpeech(this, new Init(ready, ok), pkg);
            boolean bound = ready.await(20, TimeUnit.SECONDS);
            if (bound && ok[0]) {
                tts = fresh; ttsReady = true;
                tts.setLanguage(Locale.US);
                tts.setOnUtteranceProgressListener(new Tap(this));
                if (old != null) old.shutdown();
                int n = tts.getVoices() == null ? -1 : tts.getVoices().size();
                send(os, 200, "application/json",
                    ("{\"ok\":true,\"engine\":\"" + tts.getDefaultEngine() + "\",\"voices\":" + n + "}").getBytes(), null);
            } else {
                fresh.shutdown();
                send(os, 500, "application/json",
                    ("{\"ok\":false,\"bound\":" + bound + ",\"init\":" + ok[0] + "}").getBytes(), null);
            }
            return;
        }

        // The decisive test for word highlighting: does onRangeStart fire for
        // speak() when it fires zero times for synthesizeToFile()? The engine
        // plays the audio itself here, so this endpoint is a probe, not a
        // design the plugin could use as-is.
        if (path.equals("/speak") && method.equals("POST")) {
            String text = new String(body, StandardCharsets.UTF_8);
            float rate = 1.0f;
            for (String kv : query.split("&")) if (kv.startsWith("rate=")) {
                try { rate = Float.parseFloat(kv.substring(5)); } catch (Exception ignored) {}
            }
            if (!ttsReady) { send(os, 503, "text/plain", "tts not ready".getBytes(), null); return; }
            synchronized (synthLock) {
                wantId = "s" + seq.incrementAndGet();
                done = new CountDownLatch(1);
                failed = false;
                ranges = new ArrayList<>();
                tts.setSpeechRate(rate);
                long t0 = System.nanoTime();
                int rc = tts.speak(text, TextToSpeech.QUEUE_FLUSH, new Bundle(), wantId);
                boolean fin = done.await(180, TimeUnit.SECONDS);
                long ms = (System.nanoTime() - t0) / 1_000_000L;
                StringBuilder rj = new StringBuilder("[");
                for (int i = 0; i < ranges.size(); i++) {
                    int[] r2 = ranges.get(i);
                    if (i > 0) rj.append(",");
                    rj.append("[").append(r2[0]).append(",").append(r2[1]).append("]");
                }
                rj.append("]");
                send(os, 200, "application/json",
                    ("{\"rc\":" + rc + ",\"finished\":" + fin + ",\"error\":" + failed
                     + ",\"wallMs\":" + ms + ",\"chars\":" + text.length()
                     + ",\"rangeCount\":" + ranges.size() + ",\"ranges\":" + rj + "}")
                    .getBytes(StandardCharsets.UTF_8), null);
                return;
            }
        }

        if (path.equals("/voices")) {
            StringBuilder j = new StringBuilder("[");
            if (ttsReady && tts.getVoices() != null) {
                boolean first = true;
                for (Voice v : tts.getVoices()) {
                    if (!first) j.append(","); first = false;
                    j.append("{\"name\":\"").append(v.getName())
                     .append("\",\"locale\":\"").append(v.getLocale())
                     .append("\",\"networkRequired\":").append(v.isNetworkConnectionRequired())
                     .append(",\"quality\":").append(v.getQuality()).append("}");
                }
            }
            j.append("]");
            send(os, 200, "application/json", j.toString().getBytes(StandardCharsets.UTF_8), null);
            return;
        }

        if (path.equals("/synthesize") && method.equals("POST")) {
            // Text arrives in the BODY, never the query string: a URL lands in
            // logs the way argv lands in ps.
            String text = new String(body, StandardCharsets.UTF_8);
            float rate = 1.0f;
            for (String kv : query.split("&")) {
                if (kv.startsWith("rate=")) { try { rate = Float.parseFloat(kv.substring(5)); } catch (Exception ignored) {} }
            }
            if (!ttsReady) { send(os, 503, "text/plain", "tts not ready".getBytes(), null); return; }
            if (text.isEmpty()) { send(os, 400, "text/plain", "empty body".getBytes(), null); return; }

            synchronized (synthLock) {
                File f = new File(getCacheDir(), "u" + seq.incrementAndGet() + ".wav");
                wantId = "u" + seq.get();
                done = new CountDownLatch(1);
                failed = false;
                ranges = new ArrayList<>();
                tts.setSpeechRate(rate);
                long t0 = System.nanoTime();
                int rc = tts.synthesizeToFile(text, new Bundle(), f, wantId);
                if (rc != TextToSpeech.SUCCESS) {
                    send(os, 500, "text/plain", ("synthesizeToFile rc=" + rc).getBytes(), null); return;
                }
                boolean ok = done.await(120, TimeUnit.SECONDS);
                long ms = (System.nanoTime() - t0) / 1_000_000L;
                if (!ok || failed || !f.exists()) {
                    send(os, 500, "text/plain",
                        ("synthesis failed ok=" + ok + " err=" + failed + " exists=" + f.exists()).getBytes(), null);
                    return;
                }
                byte[] wav = Files.readAllBytes(f.toPath());
                StringBuilder rj = new StringBuilder("[");
                for (int i = 0; i < ranges.size(); i++) {
                    int[] r2 = ranges.get(i);
                    if (i > 0) rj.append(",");
                    rj.append("[").append(r2[0]).append(",").append(r2[1]).append("]");
                }
                rj.append("]");
                String extra = "X-Synth-Ms: " + ms + "\r\n"
                             + "X-Chars: " + text.length() + "\r\n"
                             + "X-Rate: " + rate + "\r\n"
                             + "X-Word-Ranges: " + rj + "\r\n";
                f.delete();
                send(os, 200, "audio/wav", wav, extra);
                return;
            }
        }

        send(os, 404, "text/plain", "not found".getBytes(), null);
    }

    private void send(BufferedOutputStream os, int code, String type, byte[] body, String extra) throws IOException {
        String h = "HTTP/1.1 " + code + " OK\r\n"
                 + "Content-Type: " + type + "\r\n"
                 + "Content-Length: " + body.length + "\r\n"
                 + "Access-Control-Allow-Origin: *\r\n"
                 + "Access-Control-Allow-Headers: authorization,content-type\r\n"
                 + "Connection: close\r\n"
                 + (extra == null ? "" : extra)
                 + "\r\n";
        os.write(h.getBytes(StandardCharsets.UTF_8));
        os.write(body);
        os.flush();
    }

    @Override protected void onDestroy() {
        if (tts != null) { tts.shutdown(); }
        super.onDestroy();
    }

    @Override
    public void onInit(int status) {
        ttsReady = status == TextToSpeech.SUCCESS;
        log("TTS init: " + (ttsReady ? "SUCCESS" : "FAILED (" + status + ")"));
        if (ttsReady) {
            tts.setLanguage(Locale.US);
            int n = tts.getVoices() == null ? -1 : tts.getVoices().size();
            log("engine: " + tts.getDefaultEngine() + "  voices: " + n);
        }
    }

    /**
     * Named rather than anonymous on purpose: d8 8.2.2 fails to dex an
     * anonymous UtteranceProgressListener here with
     * "NullPointerException: Cannot invoke String.length()".
     */
    static final class Tap extends UtteranceProgressListener {
        private final MainActivity a;
        Tap(MainActivity a) { this.a = a; }
        @Override public void onStart(String id) { }
        @Override public void onDone(String id) {
            if (id.equals(a.wantId) && a.done != null) a.done.countDown();
        }
        @Override public void onError(String id) {
            if (id.equals(a.wantId) && a.done != null) { a.failed = true; a.done.countDown(); }
        }
        @Override public void onError(String id, int code) { onError(id); }
        @Override public void onRangeStart(String id, int start, int end, int frame) {
            // The reason native TTS suits this plugin: real word boundaries,
            // as source character offsets, for free.
            if (id.equals(a.wantId) && a.ranges != null) a.ranges.add(new int[]{start, end, frame});
        }
    }

    /** Named, not a lambda: see the d8 note on Tap. */
    static final class Init implements TextToSpeech.OnInitListener {
        private final CountDownLatch latch; private final boolean[] ok;
        Init(CountDownLatch l, boolean[] ok) { this.latch = l; this.ok = ok; }
        @Override public void onInit(int status) {
            ok[0] = status == TextToSpeech.SUCCESS;
            latch.countDown();
        }
    }
}
