package mijia.bridge;

import com.fasterxml.jackson.databind.ObjectMapper;
import micam.cloud.Device;
import micam.cloud.Home;
import micam.cloud.HomeApiException;
import micam.cloud.MiCloud;
import micam.cloud.Provisioning;
import micam.creds.CredentialStore;
import micam.creds.Credentials;
import micam.miss.MediaPacket;
import micam.miss.MissClient;
import micam.miss.MissCrypto;
import micam.pppp.PpppConnection;
import micam.pppp.RelaySession;
import micam.pppp.Uid;
import micam.server.HttpStreamServer;

import java.io.IOException;
import java.io.OutputStream;
import java.io.PrintStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.LongSupplier;
import java.util.function.Supplier;

/** Machine interface for Homebridge. No terminal prompts or raw upstream logs. */
public final class Bridge {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final PrintStream OUTPUT = System.out;
    private static final Set<String> REGIONS = Set.of("cn", "ru", "de", "sg", "us", "i2");
    private final CredentialStore store = new CredentialStore();
    private Credentials credentials;
    private MiCloud cloud;
    private boolean renewed;

    private static final class Failure extends RuntimeException {
        final int exit;
        final String reason;
        Failure(int exit, String reason) { super(reason); this.exit = exit; this.reason = reason; }
    }

    enum Stage {
        DEVICE_LOOKUP("device_lookup"), PROVISIONING("provisioning"), RELAY_CONNECT("relay_connect"),
        AUTHENTICATION("authentication"), WAITING_VIDEO("waiting_video");
        final String value;
        Stage(String value) { this.value = value; }
    }

    /** The first keyframe deadline is independent of subsequent non-keyframe traffic. */
    static final class VideoWatchdog {
        private final LongSupplier clock;
        private final long started;
        private final long packetTimeout;
        private final long keyframeTimeout;
        private long lastVideo;
        private boolean receivedKeyframe;

        VideoWatchdog(LongSupplier clock, Duration packetTimeout, Duration keyframeTimeout) {
            this.clock = clock;
            this.packetTimeout = packetTimeout.toNanos();
            this.keyframeTimeout = keyframeTimeout.toNanos();
            this.started = clock.getAsLong();
            this.lastVideo = started;
        }

        void observe(boolean video, boolean keyframe) {
            long now = clock.getAsLong();
            if (now - lastVideo >= packetTimeout || (!receivedKeyframe && now - started >= keyframeTimeout)) {
                throw new Failure(5, "no_video");
            }
            if (video) {
                lastVideo = now;
                if (keyframe) receivedKeyframe = true;
            }
        }
    }

    public static void main(String[] args) {
        // Even an accidental upstream println cannot contaminate the IPC channel.
        System.setOut(new PrintStream(OutputStream.nullOutputStream()));
        System.setErr(new PrintStream(OutputStream.nullOutputStream()));
        int exit;
        try { exit = new Bridge().run(args); }
        catch (Failure failure) { emit(Map.of("success", false, "reason", failure.reason)); exit = failure.exit; }
        catch (HomeApiException failure) {
            emit(Map.of("success", false, "reason", safeReason(failure.reason()),
                    "code", failure.code() == null ? 0 : failure.code()));
            exit = "session_expired".equals(failure.reason()) ? 2 : 7;
        }
        catch (Exception failure) { emit(Map.of("success", false, "reason", "backend_failed")); exit = 3; }
        System.exit(exit);
    }

    private int run(String[] args) throws IOException {
        if (args.length < 2 || !REGIONS.contains(args[1])) throw new Failure(7, "invalid_request");
        String action = args[0];
        if (!Set.of("homes", "devices", "stream").contains(action)) throw new Failure(7, "invalid_request");
        if (!(action.equals("homes") && args.length == 2)
                && !(action.equals("devices") && args.length == 4)
                && !(action.equals("stream") && (args.length == 7 || args.length == 8))) throw new Failure(7, "invalid_request");
        if (args.length >= 4) { identifier(args[2]); identifier(args[3]); }
        if (action.equals("stream")) {
            identifier(args[4]); number(args[5], 1024, 65535); number(args[6], 0, 3);
            if (args.length == 8) number(args[7], 0, 1);
        }
        try { credentials = store.load(); }
        catch (RuntimeException invalid) { throw new Failure(2, "authentication_required"); }
        credentials.region = args[1];
        cloud = new MiCloud(credentials);
        if (!credentials.hasSession()) renew();
        if (action.equals("homes") && args.length == 2) {
            List<Map<String, Object>> homes = request(cloud::homeList).stream().map(home -> Map.<String, Object>of(
                    "id", home.id(), "ownerId", home.ownerId(), "name", home.name(), "shared", home.shared())).toList();
            emit(Map.of("success", true, "homes", homes));
            return 0;
        }
        if (args.length < 4) throw new Failure(7, "invalid_request");
        Home home = new Home(identifier(args[2]), identifier(args[3]), "", false);
        if (action.equals("stream")) progress(Stage.DEVICE_LOOKUP);
        List<Device> cameras = request(() -> cloud.deviceList(home)).stream().filter(Device::isCamera).toList();
        if (action.equals("devices") && args.length == 4) {
            emit(Map.of("success", true, "devices", cameras.stream().map(device -> Map.<String, Object>of(
                    "deviceId", device.did(), "name", label(device.name()), "model", label(device.model()),
                    "online", device.online())).toList()));
            return 0;
        }
        if (!action.equals("stream") || (args.length != 7 && args.length != 8)) throw new Failure(7, "invalid_request");
        String did = identifier(args[4]);
        int port = number(args[5], 1024, 65535);
        int quality = number(args[6], 0, 3);
        Device device = cameras.stream().filter(camera -> did.equals(camera.did())).findFirst()
                .orElseThrow(() -> new Failure(7, "camera_not_in_home"));
        NightVisionControl.cacheVerifiedCapability(credentials, home, device);
        if (!device.online()) throw new Failure(4, "camera_offline");
        progress(Stage.PROVISIONING);
        Provisioning provision = request(() -> cloud.missGetVendor(did));
        if (!provision.isCs2()) {
            emit(Map.of("success", false, "reason", "unsupported_transport", "vendor", provision.vendorId()));
            return 1;
        }
        return stream(provision, port, quality, args.length == 8 && "1".equals(args[7]), device.model());
    }

    private <T> T request(Supplier<T> call) {
        try { return call.get(); }
        catch (HomeApiException failure) {
            if (!"session_expired".equals(failure.reason()) || renewed) throw failure;
            renew();
            return call.get();
        }
    }

    private void renew() {
        if (renewed || !credentials.canRenew()) throw new Failure(2, "authentication_required");
        renewed = true;
        try {
            cloud.login(null);
            // Keep the original file intact until a complete renewal succeeds.
            if (!credentials.hasSession()) throw new Failure(2, "authentication_required");
            Path file = store.path();
            Files.createDirectories(file.getParent());
            Files.setPosixFilePermissions(file.getParent(), PosixFilePermissions.fromString("rwx------"));
            Path temp = file.resolveSibling(".credentials-java-" + UUID.randomUUID() + ".tmp");
            try {
                Files.createFile(temp, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
                JSON.writeValue(temp.toFile(), credentials);
                Files.move(temp, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            } finally { Files.deleteIfExists(temp); }
        } catch (Exception failure) { throw new Failure(2, "authentication_required"); }
    }

    private int stream(Provisioning provision, int port, int quality, boolean audioEnabled, String model) {
        Resources resources = new Resources();
        AtomicBoolean running = new AtomicBoolean(true);
        Thread hook = new Thread(() -> { running.set(false); resources.close(); }, "mijia-bridge-stop");
        Runtime.getRuntime().addShutdownHook(hook);
        try {
            progress(Stage.RELAY_CONNECT, provision.vendorId());
            resources.relay = new RelaySession(Uid.parse(provision.p2pId()), provision.servers(), null);
            RelaySession.Established established = resources.relay.connect(Duration.ofSeconds(90));
            resources.connection = new PpppConnection(resources.relay.socket(), established.relay(), null);
            resources.connection.start();
            resources.camera = new MissClient(resources.connection);
            progress(Stage.AUTHENTICATION, provision.vendorId());
            resources.camera.authenticate(provision.clientPublic(), provision.sign(), Duration.ofSeconds(15));
            resources.sessionKey = MissCrypto.sessionKey(provision.clientPrivate(), provision.devicePublic());
            resources.camera.useSessionKey(resources.sessionKey);
            try {
                resources.ptz = new PtzControlServer(resources.camera, resources.sessionKey, model,
                        store.path().resolveSibling("ptz-control.json"));
                resources.ptz.start();
                emit(Map.of("success", true, "event", "control_ready", "controlPort", resources.ptz.port(), "controlToken", resources.ptz.token()));
            } catch (IOException | RuntimeException failure) {
                if (resources.ptz != null) resources.ptz.close(); resources.ptz = null;
                emit(Map.of("success", true, "event", "control_unavailable"));
            }
            progress(Stage.WAITING_VIDEO, provision.vendorId());
            resources.camera.startVideo(quality, audioEnabled);
            VideoWatchdog watchdog = new VideoWatchdog(System::nanoTime, Duration.ofSeconds(10), Duration.ofSeconds(15));
            long lastAudio = 0, lastAudioStatus = 0;
            boolean audioPresent = false, unsupportedReported = false;
            while (running.get()) {
                MediaPacket frame = resources.camera.nextMedia(Duration.ofSeconds(1));
                watchdog.observe(frame != null && frame.isVideo(), frame != null && frame.isVideo() && frame.isKeyframe());
                long now = System.nanoTime();
                if (audioEnabled && frame != null && !frame.isVideo()) {
                    AudioStreamServer.Format format = AudioStreamServer.Format.of(frame);
                    if (format != null) {
                        if (resources.audio == null) {
                            try {
                                resources.talkback = new Talkback(resources.camera, resources.connection, resources.sessionKey);
                                resources.audio = new AudioStreamServer(format, resources.talkback);
                                resources.audio.start();
                                emit(Map.ofEntries(Map.entry("success", true), Map.entry("event", "audio_ready"),
                                        Map.entry("audioPort", resources.audio.port()), Map.entry("audioCodec", format.codec()),
                                        Map.entry("format", format.codec().equals("PCMA") ? "wav" : "ogg"),
                                        Map.entry("sampleRate", format.sampleRate()), Map.entry("channels", format.channels()),
                                        Map.entry("talkFormat", format.talkFormat()), Map.entry("talkSampleRate", format.talkSampleRate()),
                                        Map.entry("talkChannels", format.talkChannels()), Map.entry("talkPath", format.talkPath()),
                                        Map.entry("flags", frame.flags()), Map.entry("payloadBytes", frame.payload().length)));
                            } catch (IOException | RuntimeException failure) {
                                if (resources.audio != null) resources.audio.close();
                                resources.audio = null;
                                if (resources.talkback != null) resources.talkback.close();
                                resources.talkback = null;
                                emit(Map.of("success", true, "event", "audio_status", "audioReceived", false));
                            }
                        }
                        if (resources.audio != null && resources.audio.format().equals(format)) {
                            resources.audio.publish(frame);
                            lastAudio = now;
                            if (!audioPresent || now - lastAudioStatus >= Duration.ofSeconds(5).toNanos()) {
                                emit(Map.of("success", true, "event", "audio_status", "audioReceived", true));
                                lastAudioStatus = now;
                            }
                            audioPresent = true;
                        }
                    } else if (!unsupportedReported) {
                        emit(Map.of("success", true, "event", "audio_unsupported", "codecId", frame.codecId(),
                                "flags", frame.flags(), "payloadBytes", frame.payload().length));
                        unsupportedReported = true;
                    }
                }
                if (audioPresent && now - lastAudio >= Duration.ofSeconds(10).toNanos()) {
                    emit(Map.of("success", true, "event", "audio_status", "audioReceived", false));
                    audioPresent = false;
                }
                if (frame == null || !frame.isVideo()) {
                    continue;
                }
                if (resources.server == null) {
                    if (!frame.isKeyframe()) continue;
                    resources.server = new HttpStreamServer(port, "/cam.ts", null);
                    resources.server.start();
                    emit(Map.of("success", true, "event", "ready", "port", port,
                            "videoReceived", true, "codec", frame.codecName()));
                }
                resources.server.publish(frame);
            }
            return 0;
        } catch (java.net.BindException failure) { throw new Failure(6, "port_in_use"); }
        catch (Failure failure) { throw failure; }
        catch (Exception failure) { throw new Failure(3, "connection_failed"); }
        finally {
            resources.close();
            try { Runtime.getRuntime().removeShutdownHook(hook); }
            catch (IllegalStateException ignored) { }
        }
    }

    private static final class Resources {
        volatile RelaySession relay;
        volatile PpppConnection connection;
        volatile MissClient camera;
        volatile HttpStreamServer server;
        volatile AudioStreamServer audio;
        volatile Talkback talkback;
        volatile PtzControlServer ptz;
        volatile byte[] sessionKey;
        synchronized void close() {
            if (ptz != null) { try { ptz.close(); } catch (Exception ignored) { } ptz = null; }
            if (audio != null) { try { audio.close(); } catch (Exception ignored) { } audio = null; }
            if (talkback != null) { try { talkback.close(); } catch (Exception ignored) { } talkback = null; }
            if (camera != null) { try { camera.stopVideo(); } catch (Exception ignored) { } camera = null; }
            if (server != null) { try { server.close(); } catch (Exception ignored) { } server = null; }
            if (connection != null) { try { connection.close(); } catch (Exception ignored) { } connection = null; }
            if (relay != null) { try { relay.close(); } catch (Exception ignored) { } relay = null; }
            if (sessionKey != null) { java.util.Arrays.fill(sessionKey, (byte) 0); sessionKey = null; }
        }
    }

    private static String identifier(String value) {
        if (value == null || !value.matches("[0-9]{1,30}")) throw new Failure(7, "invalid_request");
        return new java.math.BigInteger(value).toString();
    }
    private static int number(String value, int min, int max) {
        try { int parsed = Integer.parseInt(value); if (parsed >= min && parsed <= max) return parsed; }
        catch (NumberFormatException ignored) { }
        throw new Failure(7, "invalid_request");
    }
    private static String label(String value) {
        if (value == null) return "";
        String cleaned = value.replaceAll("[\\p{Cc}]", " ");
        return cleaned.length() > 160 ? cleaned.substring(0, 160) : cleaned;
    }
    private static String safeReason(String value) {
        return Set.of("session_expired", "invalid_home_selection", "invalid_home_response", "missing_home_owner",
                "invalid_device_response", "device_pagination_incomplete", "home_request_failed", "home_request_rejected")
                .contains(value) ? value : "discovery_failed";
    }
    static void progress(Stage stage) {
        emit(Map.of("success", true, "event", "progress", "stage", stage.value));
    }
    static void progress(Stage stage, int vendor) {
        emit(Map.of("success", true, "event", "progress", "stage", stage.value, "vendor", vendor));
    }
    private static synchronized void emit(Object value) {
        try { OUTPUT.println(JSON.writeValueAsString(value)); OUTPUT.flush(); }
        catch (Exception ignored) { }
    }
}
