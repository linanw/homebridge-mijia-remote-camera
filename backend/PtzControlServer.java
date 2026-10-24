package mijia.bridge;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import micam.miss.MissClient;
import micam.miss.MissCrypto;

import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Duration;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/** Bounded single-step motor control on the existing encrypted MISS session. No startup movement. */
final class PtzControlServer implements AutoCloseable {
    private static final ObjectMapper JSON = new ObjectMapper()
            .enable(com.fasterxml.jackson.core.JsonParser.Feature.STRICT_DUPLICATE_DETECTION)
            .enable(com.fasterxml.jackson.databind.DeserializationFeature.FAIL_ON_TRAILING_TOKENS);
    private static final int MOTOR_REQUEST = 0x112, MOTOR_RESPONSE = 0x113;
    private static final Set<String> PROBE_MODELS = Set.of("chuangmi.camera.061a01");
    // Physically verified on this exact model. One command is a finite step; no precise angle is implied.
    private static final Map<String, Map<String, Integer>> PROFILES = Map.of("chuangmi.camera.061a01",
            Map.of("left", 1, "right", 2, "up", 3, "down", 4));
    private static final long COOLDOWN_NANOS = TimeUnit.MILLISECONDS.toNanos(1800);
    interface Session {
        void send(int command, String body);
        MissClient.Response receive(Duration timeout);
    }
    private final Session session;
    private final byte[] key;
    private final String model, token;
    private final Path descriptor;
    private final HttpServer server;
    private final ThreadPoolExecutor executor = new ThreadPoolExecutor(2, 2, 0, TimeUnit.SECONDS,
            new ArrayBlockingQueue<>(2), runnable -> { Thread thread = new Thread(runnable, "mijia-ptz-http"); thread.setDaemon(true); return thread; });
    private final ScheduledExecutorService deadlines = Executors.newSingleThreadScheduledExecutor(runnable -> {
        Thread thread = new Thread(runnable, "mijia-ptz-deadlines"); thread.setDaemon(true); return thread;
    });
    private final AtomicBoolean busy = new AtomicBoolean();
    private volatile boolean closed;
    private volatile CompletableFuture<Map<String, Object>> pending;
    private long lastCommand = Long.MIN_VALUE;
    private Thread reader;

    PtzControlServer(MissClient camera, byte[] key, String model, Path descriptor) throws IOException {
        this(new Session() {
            public void send(int command, String body) { camera.sendEncrypted(command, body); }
            public MissClient.Response receive(Duration timeout) { return camera.awaitResponse(timeout); }
        }, key, model, descriptor);
    }
    PtzControlServer(Session session, byte[] key, String model, Path descriptor) throws IOException {
        if (session == null || key == null || key.length != 32 || model == null) throw new IOException("ptz_unavailable");
        this.session = session; this.key = Arrays.copyOf(key, key.length); this.model = model; this.descriptor = descriptor;
        byte[] random = new byte[32]; new SecureRandom().nextBytes(random); token = HexFormat.of().formatHex(random); Arrays.fill(random, (byte) 0);
        server = HttpServer.create(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0), 4);
        server.setExecutor(executor); server.createContext("/", this::handle);
    }
    int port() { return server.getAddress().getPort(); }
    String token() { return token; }
    static boolean supported(String model) { return PROFILES.containsKey(model); }
    void start() throws IOException {
        reader = new Thread(this::readLoop, "mijia-ptz-commands"); reader.setDaemon(true); reader.start();
        try { writeDescriptor(); server.start(); } catch (IOException | RuntimeException error) { close(); throw error; }
    }
    private void writeDescriptor() throws IOException {
        if (descriptor == null) return;
        Files.createDirectories(descriptor.getParent());
        Files.setPosixFilePermissions(descriptor.getParent(), PosixFilePermissions.fromString("rwx------"));
        Path temporary = descriptor.resolveSibling(".ptz-control-" + UUID.randomUUID() + ".tmp");
        try {
            Files.createFile(temporary, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
            JSON.writeValue(temporary.toFile(), Map.of("version", 1, "port", port(), "token", token, "model", model,
                    "pid", ProcessHandle.current().pid(), "createdAt", System.currentTimeMillis()));
            Files.move(temporary, descriptor, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } finally { Files.deleteIfExists(temporary); }
    }
    private void handle(HttpExchange exchange) throws IOException {
        String host = exchange.getRequestHeaders().getFirst("Host"), authorization = exchange.getRequestHeaders().getFirst("Authorization");
        if (closed || !exchange.getRemoteAddress().getAddress().isLoopbackAddress() || !("127.0.0.1:" + port()).equals(host)
                || exchange.getRequestURI().getRawQuery() != null || exchange.getRequestHeaders().containsKey("Origin")
                || authorization == null || !MessageDigest.isEqual(("Bearer " + token).getBytes(StandardCharsets.US_ASCII), authorization.getBytes(StandardCharsets.UTF_8))) {
            respond(exchange, 403, Map.of("reason", "ptz_unavailable")); return;
        }
        String route = exchange.getRequestURI().getRawPath();
        if (!exchange.getRequestMethod().equals("POST") || !(route.equals("/ptz/probe") || route.equals("/ptz/move"))) {
            respond(exchange, 404, Map.of("reason", "invalid_request")); return;
        }
        int length;
        try { length = Integer.parseInt(exchange.getRequestHeaders().getFirst("Content-Length")); }
        catch (Exception error) { respond(exchange, 400, Map.of("reason", "invalid_request")); return; }
        if (length < 2 || length > 128 || !"application/json".equals(exchange.getRequestHeaders().getFirst("Content-Type"))) {
            respond(exchange, 400, Map.of("reason", "invalid_request")); return;
        }
        var timeout = deadlines.schedule(exchange::close, 3, TimeUnit.SECONDS);
        try {
            byte[] bytes = exchange.getRequestBody().readNBytes(length);
            JsonNode payload;
            try { payload = bytes.length == length ? JSON.readTree(bytes) : null; } finally { Arrays.fill(bytes, (byte) 0); }
            if (payload == null || !payload.isObject() || payload.size() != 1) { respond(exchange, 400, Map.of("reason", "invalid_request")); return; }
            int operation;
            if (route.equals("/ptz/probe")) {
                if (!PROBE_MODELS.contains(model) || !payload.path("operation").isIntegralNumber() || !payload.path("operation").canConvertToInt()) {
                    respond(exchange, 400, Map.of("reason", "ptz_unsupported")); return;
                }
                operation = payload.path("operation").intValue();
            } else {
                String direction = payload.path("direction").asText("");
                Map<String, Integer> profile = PROFILES.get(model);
                if (profile == null) { respond(exchange, 409, Map.of("reason", "ptz_unsupported")); return; }
                operation = profile.getOrDefault(direction, 0);
            }
            if (operation < 1 || operation > 4) { respond(exchange, 400, Map.of("reason", "invalid_request")); return; }
            Map<String, Object> result = probeStep(operation);
            if (route.equals("/ptz/move")) {
                if (!Integer.valueOf(0).equals(result.get("ret"))) throw new ControlFailure("ptz_rejected");
                result = Map.of("accepted", true, "direction", payload.path("direction").asText(), "movement", "step");
            }
            respond(exchange, 200, result);
        } catch (ControlFailure error) { respond(exchange, error.reason.equals("ptz_busy") ? 429 : 503, Map.of("reason", error.reason)); }
        catch (Exception error) { respond(exchange, 503, Map.of("reason", "ptz_unavailable")); }
        finally { timeout.cancel(false); exchange.close(); }
    }
    Map<String, Object> probeStep(int operation) {
        if (operation < 1 || operation > 4) throw new ControlFailure("invalid_request");
        if (closed) throw new ControlFailure("ptz_unavailable");
        if (!busy.compareAndSet(false, true)) throw new ControlFailure("ptz_busy");
        CompletableFuture<Map<String, Object>> response = new CompletableFuture<>();
        try {
            synchronized (this) {
                if (closed) throw new ControlFailure("ptz_unavailable");
                long now = System.nanoTime();
                if (lastCommand != Long.MIN_VALUE && now - lastCommand < COOLDOWN_NANOS) throw new ControlFailure("ptz_busy");
                lastCommand = now; pending = response;
                session.send(MOTOR_REQUEST, "{\"operation\":" + operation + "}");
            }
            try {
                Map<String, Object> result = new LinkedHashMap<>(response.get(2, TimeUnit.SECONDS));
                if (closed) throw new ControlFailure("ptz_unavailable");
                result.put("sent", true); result.put("responded", true); result.put("operation", operation);
                return result;
            } catch (java.util.concurrent.TimeoutException timeout) { lastCommand = System.nanoTime(); throw new ControlFailure("ptz_timeout"); }
            catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); throw new ControlFailure("ptz_unavailable"); }
            catch (java.util.concurrent.ExecutionException error) { throw new ControlFailure("ptz_unavailable"); }
        } finally { if (pending == response) pending = null; busy.set(false); }
    }
    private void readLoop() {
        while (!closed) {
            try {
                MissClient.Response response = session.receive(Duration.ofMillis(100));
                if (response == null) continue;
                Map<String, Object> safe = motorResponse(response, key);
                CompletableFuture<Map<String, Object>> waiter = pending;
                if (safe != null && waiter != null) waiter.complete(safe);
            } catch (RuntimeException ignored) {
                try { Thread.sleep(20); } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); return; }
            }
        }
    }
    static Map<String, Object> motorResponse(MissClient.Response response, byte[] key) {
        if (response == null || response.command() != MissClient.CMD_ENCODED || response.body() == null || response.body().length > 4108) return null;
        byte[] plain = null;
        try {
            int command = response.command();
            if (command == MissClient.CMD_ENCODED) {
                if (response.body().length < 12) return null;
                plain = MissCrypto.decrypt(key, response.body());
                if (plain.length < 4) return null;
                command = ByteBuffer.wrap(plain).order(ByteOrder.BIG_ENDIAN).getInt();
            } else plain = Arrays.copyOf(response.body(), response.body().length);
            if (command != MOTOR_RESPONSE) return null;
            int offset = response.command() == MissClient.CMD_ENCODED ? 4 : 0, length = plain.length - offset;
            while (length > 0 && plain[offset + length - 1] == 0) --length;
            JsonNode value = JSON.readTree(Arrays.copyOfRange(plain, offset, offset + length));
            if (value == null || !value.isObject()) return null;
            Map<String, Object> result = new LinkedHashMap<>();
            for (String name : Set.of("ret", "angle", "elevation", "xAngle", "yAngle", "xStep", "yStep")) {
                JsonNode number = value.get(name);
                if (number != null && number.isIntegralNumber() && number.canConvertToInt() && Math.abs((long) number.intValue()) <= 36000)
                    result.put(name, number.intValue());
            }
            return result.isEmpty() ? null : result;
        } catch (Exception ignored) { return null; }
        finally { if (plain != null) Arrays.fill(plain, (byte) 0); }
    }
    private static void respond(HttpExchange exchange, int status, Map<String, Object> value) throws IOException {
        byte[] body = JSON.writeValueAsBytes(value);
        exchange.getResponseHeaders().set("Content-Type", "application/json"); exchange.getResponseHeaders().set("Cache-Control", "no-store");
        exchange.sendResponseHeaders(status, body.length);
        try (var output = exchange.getResponseBody()) { output.write(body); } finally { Arrays.fill(body, (byte) 0); }
    }
    static final class ControlFailure extends RuntimeException { final String reason; ControlFailure(String reason) { super(reason); this.reason = reason; } }
    @Override public synchronized void close() {
        if (closed) return; closed = true;
        CompletableFuture<Map<String, Object>> waiter = pending; if (waiter != null) waiter.completeExceptionally(new ControlFailure("ptz_unavailable"));
        server.stop(0); executor.shutdownNow(); deadlines.shutdownNow(); if (reader != null) reader.interrupt(); Arrays.fill(key, (byte) 0);
        if (descriptor != null) try {
            JsonNode value = JSON.readTree(descriptor.toFile()); if (token.equals(value.path("token").asText())) Files.deleteIfExists(descriptor);
        } catch (Exception ignored) { }
    }
}
