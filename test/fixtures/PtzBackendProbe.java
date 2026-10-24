package mijia.bridge;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import micam.miss.MissClient;
import micam.miss.MissCrypto;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Duration;
import java.util.Arrays;
import java.util.Comparator;
import java.util.Map;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executors;

/** Synthetic session and loopback HTTP only. No credentials, camera connection, or cloud API. */
public final class PtzBackendProbe {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final byte[] KEY = new byte[32];
    private static int checks;
    private static void check(boolean value) { ++checks; if (!value) throw new AssertionError("ptz_fixture_failed"); }
    private static MissClient.Response encrypted(int command, String value) {
        byte[] body = value.getBytes(StandardCharsets.UTF_8), inner = ByteBuffer.allocate(4 + body.length).putInt(command).put(body).array();
        try { return new MissClient.Response(MissClient.CMD_ENCODED, MissCrypto.encrypt(KEY, inner)); }
        finally { Arrays.fill(inner, (byte) 0); Arrays.fill(body, (byte) 0); }
    }
    public static void main(String[] args) throws Exception {
        check(PtzControlServer.supported("chuangmi.camera.061a01"));
        check(!PtzControlServer.supported("chuangmi.camera.061a03"));
        check(PtzControlServer.motorResponse(new MissClient.Response(0x113, "{\"ret\":0}".getBytes(StandardCharsets.UTF_8)), KEY) == null);
        check(PtzControlServer.motorResponse(encrypted(0x107, "{\"ret\":0}"), KEY) == null);
        check(PtzControlServer.motorResponse(encrypted(0x113, "PRIVATE_TOKEN"), KEY) == null);
        Map<String, Object> response = PtzControlServer.motorResponse(encrypted(0x113,
                "{\"ret\":0,\"angle\":49,\"elevation\":50,\"xStep\":1,\"token\":\"PRIVATE_TOKEN\"}\u0000"), KEY);
        check(response.equals(Map.of("ret", 0, "angle", 49, "elevation", 50, "xStep", 1)));
        check(!JSON.writeValueAsString(response).contains("PRIVATE"));
        check(PtzControlServer.motorResponse(encrypted(0x113, "{\"ret\":\"PRIVATE\",\"angle\":999999999999999999999}"), KEY) == null);
        Path directory = Files.createTempDirectory("mijia-ptz-probe-");
        AtomicInteger sends = new AtomicInteger(); LinkedBlockingQueue<MissClient.Response> incoming = new LinkedBlockingQueue<>();
        PtzControlServer.Session session = new PtzControlServer.Session() {
            public void send(int command, String body) {
                check(command == 0x112 && body.equals("{\"operation\":1}")); sends.incrementAndGet();
                incoming.offer(encrypted(0x113, "{\"ret\":0,\"angle\":48,\"elevation\":50,\"raw\":\"PRIVATE_TOKEN\"}"));
            }
            public MissClient.Response receive(Duration timeout) {
                try { return incoming.poll(timeout.toMillis(), TimeUnit.MILLISECONDS); }
                catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); return null; }
            }
        };
        Path descriptor = directory.resolve(".micam/ptz-control.json");
        try (PtzControlServer server = new PtzControlServer(session, KEY, "chuangmi.camera.061a01", descriptor)) {
            server.start(); check(sends.get() == 0);
            check(Files.getPosixFilePermissions(descriptor).equals(PosixFilePermissions.fromString("rw-------")));
            check(Files.getPosixFilePermissions(descriptor.getParent()).equals(PosixFilePermissions.fromString("rwx------")));
            try (HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(1)).build()) {
                check(post(http, server, "/ptz/probe", "{\"operation\":1}", "WRONG").statusCode() == 403);
                check(post(http, server, "/ptz/probe", "{\"operation\":5}", server.token()).statusCode() == 400);
                check(post(http, server, "/ptz/probe", "{\"operation\":1,\"command\":999}", server.token()).statusCode() == 400);
                check(post(http, server, "/ptz/move", "{\"direction\":\"stop\"}", server.token()).statusCode() == 400);
                check(sends.get() == 0);
                HttpResponse<String> result = post(http, server, "/ptz/probe", "{\"operation\":1}", server.token());
                JsonNode value = JSON.readTree(result.body());
                check(result.statusCode() == 200 && value.path("sent").asBoolean() && value.path("responded").asBoolean());
                check(value.path("operation").asInt() == 1 && value.path("ret").asInt(-1) == 0 && value.path("angle").asInt() == 48);
                check(!result.body().contains("PRIVATE") && !result.body().contains(server.token()));
                check(post(http, server, "/ptz/probe", "{\"operation\":1}", server.token()).statusCode() == 429);
                check(sends.get() == 1);
                try { server.probeStep(-1001); throw new AssertionError("unexpected_operation"); }
                catch (PtzControlServer.ControlFailure invalid) { check(invalid.reason.equals("invalid_request")); }
            }
        } finally {
            check(!Files.exists(descriptor));
            try (var entries = Files.walk(directory)) { for (Path entry : entries.sorted(Comparator.reverseOrder()).toList()) Files.deleteIfExists(entry); }
        }
        directionalMoves();
        timeoutAndClose();
        System.out.println(JSON.writeValueAsString(Map.of("success", true, "checks", checks)));
    }
    private static void directionalMoves() throws Exception {
        try (HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(1)).build()) {
            for (Map.Entry<String, Integer> direction : Map.of("left", 1, "right", 2, "up", 3, "down", 4).entrySet()) {
                AtomicInteger sends = new AtomicInteger(); LinkedBlockingQueue<MissClient.Response> incoming = new LinkedBlockingQueue<>();
                PtzControlServer.Session session = new PtzControlServer.Session() {
                    public void send(int command, String body) {
                        check(command == 0x112 && body.equals("{\"operation\":" + direction.getValue() + "}")); sends.incrementAndGet();
                        incoming.offer(encrypted(0x113, "{\"ret\":0,\"angle\":51,\"elevation\":8,\"private\":\"PRIVATE_TOKEN\"}"));
                    }
                    public MissClient.Response receive(Duration timeout) {
                        try { return incoming.poll(timeout.toMillis(), TimeUnit.MILLISECONDS); }
                        catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); return null; }
                    }
                };
                try (PtzControlServer server = new PtzControlServer(session, KEY, "chuangmi.camera.061a01", null)) {
                    server.start();
                    HttpResponse<String> result = post(http, server, "/ptz/move", "{\"direction\":\"" + direction.getKey() + "\"}", server.token());
                    check(result.statusCode() == 200 && JSON.readTree(result.body()).equals(JSON.valueToTree(
                            Map.of("accepted", true, "direction", direction.getKey(), "movement", "step"))));
                    check(sends.get() == 1);
                }
            }
            for (String reply : new String[] { "{\"ret\":1}", "{\"angle\":51}" }) {
                LinkedBlockingQueue<MissClient.Response> incoming = new LinkedBlockingQueue<>();
                PtzControlServer.Session session = new PtzControlServer.Session() {
                    public void send(int command, String body) { incoming.offer(encrypted(0x113, reply)); }
                    public MissClient.Response receive(Duration timeout) {
                        try { return incoming.poll(timeout.toMillis(), TimeUnit.MILLISECONDS); }
                        catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); return null; }
                    }
                };
                try (PtzControlServer server = new PtzControlServer(session, KEY, "chuangmi.camera.061a01", null)) {
                    server.start(); HttpResponse<String> result = post(http, server, "/ptz/move", "{\"direction\":\"left\"}", server.token());
                    check(result.statusCode() == 503 && JSON.readTree(result.body()).path("reason").asText().equals("ptz_rejected"));
                    check(!result.body().contains("accepted"));
                }
            }
            AtomicInteger sends = new AtomicInteger();
            PtzControlServer.Session unknownSession = new PtzControlServer.Session() {
                public void send(int command, String body) { sends.incrementAndGet(); }
                public MissClient.Response receive(Duration timeout) {
                    try { Thread.sleep(50); } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
                    return null;
                }
            };
            try (PtzControlServer server = new PtzControlServer(unknownSession, KEY, "chuangmi.camera.061a03", null)) {
                server.start(); HttpResponse<String> result = post(http, server, "/ptz/move", "{\"direction\":\"left\"}", server.token());
                check(result.statusCode() == 409 && JSON.readTree(result.body()).path("reason").asText().equals("ptz_unsupported"));
                check(sends.get() == 0);
            }
        }
    }
    private static void timeoutAndClose() throws Exception {
        AtomicInteger sends = new AtomicInteger();
        LinkedBlockingQueue<MissClient.Response> incoming = new LinkedBlockingQueue<>();
        incoming.offer(encrypted(0x113, "{\"ret\":0,\"angle\":49}"));
        CompletableFuture<Void> sent = new CompletableFuture<>();
        PtzControlServer.Session session = new PtzControlServer.Session() {
            public void send(int command, String body) { sends.incrementAndGet(); sent.complete(null); }
            public MissClient.Response receive(Duration timeout) {
                try { return incoming.poll(timeout.toMillis(), TimeUnit.MILLISECONDS); }
                catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); return null; }
            }
        };
        try (PtzControlServer server = new PtzControlServer(session, KEY, "chuangmi.camera.061a01", null)) {
            server.start(); Thread.sleep(150);
            try { server.probeStep(1); throw new AssertionError("expected_timeout"); }
            catch (PtzControlServer.ControlFailure timeout) { check(timeout.reason.equals("ptz_timeout")); }
            check(sends.get() == 1);
            try { server.probeStep(2); throw new AssertionError("expected_quarantine"); }
            catch (PtzControlServer.ControlFailure busy) { check(busy.reason.equals("ptz_busy")); }
            check(sends.get() == 1);
        }
        sends.set(0);
        CompletableFuture<Void> active = new CompletableFuture<>();
        PtzControlServer.Session closingSession = new PtzControlServer.Session() {
            public void send(int command, String body) { sends.incrementAndGet(); active.complete(null); }
            public MissClient.Response receive(Duration timeout) {
                try { Thread.sleep(50); } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
                return null;
            }
        };
        try (PtzControlServer server = new PtzControlServer(closingSession, KEY, "chuangmi.camera.061a01", null);
             var worker = Executors.newSingleThreadExecutor()) {
            server.start();
            var pending = worker.submit(() -> {
                try { server.probeStep(1); return "unexpected_success"; }
                catch (PtzControlServer.ControlFailure failure) { return failure.reason; }
            });
            active.get(1, TimeUnit.SECONDS);
            try { server.probeStep(2); throw new AssertionError("expected_busy"); }
            catch (PtzControlServer.ControlFailure busy) { check(busy.reason.equals("ptz_busy")); }
            server.close(); check(pending.get(1, TimeUnit.SECONDS).equals("ptz_unavailable"));
            try { server.probeStep(1); throw new AssertionError("expected_closed"); }
            catch (PtzControlServer.ControlFailure closed) { check(closed.reason.equals("ptz_unavailable")); }
            check(sends.get() == 1);
        }
    }
    private static HttpResponse<String> post(HttpClient http, PtzControlServer server, String path, String body, String token) throws Exception {
        return http.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + server.port() + path)).timeout(Duration.ofSeconds(4))
                .header("Content-Type", "application/json").header("Authorization", "Bearer " + token)
                .POST(HttpRequest.BodyPublishers.ofString(body)).build(), HttpResponse.BodyHandlers.ofString());
    }
}
