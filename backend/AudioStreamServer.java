package mijia.bridge;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import micam.miss.MediaPacket;

import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.Set;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CopyOnWriteArraySet;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.Semaphore;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/** Loopback-only live audio and one bounded talkback POST. Camera readout never waits for a listener. */
final class AudioStreamServer implements Closeable {
    record Format(String codec, int sampleRate, int channels) {
        static Format of(MediaPacket packet) {
            if (packet.payload().length == 0 || packet.payload().length > AudioCodecs.MAX_PACKET) return null;
            if (packet.codecId() == MediaPacket.CODEC_PCMA)
                return new Format("PCMA", ((packet.flags() >>> 3) & 15) == 0 ? 8000 : 16000, 1);
            if (packet.codecId() == MediaPacket.CODEC_OPUS) {
                try { AudioCodecs.opusSamples(packet.payload()); } catch (IllegalArgumentException invalid) { return null; }
                return new Format("OPUS", 48000, 2);
            }
            return null;
        }
        String path() { return codec.equals("PCMA") ? "/audio.wav" : "/audio.ogg"; }
        String talkPath() { return codec.equals("PCMA") ? "/talk.pcm" : "/talk.ogg"; }
        String talkFormat() { return codec.equals("PCMA") ? "s16le" : "ogg"; }
        int talkSampleRate() { return codec.equals("PCMA") ? 8000 : 48000; }
        int talkChannels() { return codec.equals("PCMA") ? 1 : 2; }
    }

    private final HttpServer server;
    private final ThreadPoolExecutor executor;
    private final ScheduledExecutorService timer;
    private final Format format;
    private final Talkback talkback;
    private final Set<Viewer> viewers = new CopyOnWriteArraySet<>();
    private final Semaphore viewerSlots = new Semaphore(4);
    private final AtomicBoolean talking = new AtomicBoolean();
    private final AtomicReference<HttpExchange> talkExchange = new AtomicReference<>();
    private volatile long lastTalkActivity, talkStarted;
    private volatile boolean closed;

    AudioStreamServer(Format format, Talkback talkback) throws IOException {
        this.format = format; this.talkback = talkback;
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 8);
        executor = new ThreadPoolExecutor(6, 6, 30, TimeUnit.SECONDS, new ArrayBlockingQueue<>(16), runnable -> {
            Thread thread = new Thread(runnable, "mijia-audio-http"); thread.setDaemon(true); return thread;
        }, new ThreadPoolExecutor.AbortPolicy());
        server.setExecutor(executor);
        server.createContext("/", this::handle);
        timer = Executors.newSingleThreadScheduledExecutor(runnable -> {
            Thread thread = new Thread(runnable, "mijia-talk-timeout"); thread.setDaemon(true); return thread;
        });
        timer.scheduleAtFixedRate(() -> {
            HttpExchange exchange = talkExchange.get();
            long now = System.nanoTime();
            if (exchange != null && (now - lastTalkActivity > TimeUnit.SECONDS.toNanos(5)
                    || now - talkStarted > TimeUnit.MINUTES.toNanos(2))) exchange.close();
        }, 1, 1, TimeUnit.SECONDS);
    }

    int port() { return server.getAddress().getPort(); }
    Format format() { return format; }
    void start() { server.start(); }

    void publish(MediaPacket packet) {
        if (closed || !format.equals(Format.of(packet))) return;
        byte[] payload = packet.payload();
        for (Viewer viewer : viewers) viewer.offer(payload);
    }

    private void handle(HttpExchange exchange) throws IOException {
        String path = exchange.getRequestURI().getRawPath();
        String host = exchange.getRequestHeaders().getFirst("Host");
        if (closed || !exchange.getRemoteAddress().getAddress().isLoopbackAddress()
                || !("127.0.0.1:" + port()).equals(host) || exchange.getRequestURI().getRawQuery() != null
                || exchange.getRequestHeaders().containsKey("Origin")) { reject(exchange, 403); return; }
        if (path.equals(format.path()) && exchange.getRequestMethod().equals("GET")) { listen(exchange); return; }
        if (path.equals(format.talkPath()) && exchange.getRequestMethod().equals("POST") && talkback != null) { talk(exchange); return; }
        reject(exchange, path.equals(format.path()) || path.equals(format.talkPath()) ? 405 : 404);
    }

    private void listen(HttpExchange exchange) throws IOException {
        if (!viewerSlots.tryAcquire()) { reject(exchange, 503); return; }
        Viewer viewer = new Viewer();
        viewers.add(viewer);
        try {
        exchange.getResponseHeaders().set("Content-Type", format.codec.equals("PCMA") ? "audio/wav" : "audio/ogg");
        exchange.getResponseHeaders().set("Cache-Control", "no-store");
        exchange.sendResponseHeaders(200, 0);
        try (OutputStream output = exchange.getResponseBody()) {
            AudioCodecs.OggWriter ogg = format.codec.equals("OPUS") ? new AudioCodecs.OggWriter(new SecureRandom().nextInt()) : null;
            output.write(ogg == null ? AudioCodecs.wavHeader(format.sampleRate) : ogg.headers()); output.flush();
            long lastPacket = System.nanoTime();
            while (!closed) {
                byte[] packet;
                try { packet = viewer.queue.poll(250, TimeUnit.MILLISECONDS); }
                catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); return; }
                if (packet == null) {
                    if (System.nanoTime() - lastPacket > TimeUnit.SECONDS.toNanos(10)) return;
                    continue;
                }
                lastPacket = System.nanoTime();
                try {
                    byte[] encoded = ogg == null ? AudioCodecs.pcmFromAlaw(packet) : ogg.packet(packet);
                    try { output.write(encoded); output.flush(); }
                    finally { Arrays.fill(encoded, (byte) 0); }
                } finally { Arrays.fill(packet, (byte) 0); }
            }
        }
        } catch (IOException ignored) { }
        finally { viewers.remove(viewer); viewer.clear(); viewerSlots.release(); exchange.close(); }
    }

    private void talk(HttpExchange exchange) throws IOException {
        if (!talking.compareAndSet(false, true)) { reject(exchange, 409); return; }
        talkStarted = lastTalkActivity = System.nanoTime(); talkExchange.set(exchange);
        boolean started = false;
        // The response acknowledges the local transport; speaker/codec correctness is verified separately on the real camera.
        try {
        exchange.getResponseHeaders().set("Cache-Control", "no-store"); exchange.sendResponseHeaders(200, 0);
        try (InputStream input = exchange.getRequestBody(); OutputStream response = exchange.getResponseBody()) {
            if (format.codec.equals("PCMA")) {
                byte[] pcm;
                while (!closed && (pcm = input.readNBytes(640)).length > 0) {
                    lastTalkActivity = System.nanoTime();
                    if (pcm.length != 640) { Arrays.fill(pcm, (byte) 0); break; }
                    if (!started) { talkback.start(); started = true; }
                    try { talkback.pcma(pcm); } finally { Arrays.fill(pcm, (byte) 0); }
                }
            } else {
                AudioCodecs.OggReader ogg = new AudioCodecs.OggReader(input);
                byte[] packet;
                while (!closed && (packet = ogg.next()) != null) {
                    lastTalkActivity = System.nanoTime();
                    if (!started) { talkback.start(); started = true; }
                    try { talkback.opus(packet); } finally { Arrays.fill(packet, (byte) 0); }
                }
            }
        }
        } catch (IOException | RuntimeException ignored) { }
        finally {
            if (started) talkback.stop();
            talkExchange.compareAndSet(exchange, null); talking.set(false); exchange.close();
        }
    }

    private static void reject(HttpExchange exchange, int status) throws IOException {
        exchange.sendResponseHeaders(status, -1); exchange.close();
    }

    @Override public void close() {
        if (closed) return; closed = true;
        HttpExchange exchange = talkExchange.getAndSet(null); if (exchange != null) exchange.close();
        server.stop(0); timer.shutdownNow(); executor.shutdownNow();
        if (talkback != null) talkback.close();
        for (Viewer viewer : viewers) viewer.clear(); viewers.clear();
    }

    private static final class Viewer {
        final ArrayBlockingQueue<byte[]> queue = new ArrayBlockingQueue<>(64);
        void offer(byte[] bytes) {
            byte[] own = Arrays.copyOf(bytes, bytes.length);
            if (!queue.offer(own)) { byte[] dropped = queue.poll(); if (dropped != null) Arrays.fill(dropped, (byte) 0); if (!queue.offer(own)) Arrays.fill(own, (byte) 0); }
        }
        void clear() { byte[] bytes; while ((bytes = queue.poll()) != null) Arrays.fill(bytes, (byte) 0); }
    }
}
