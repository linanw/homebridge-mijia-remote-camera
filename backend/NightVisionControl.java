package mijia.bridge;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import micam.cloud.Device;
import micam.cloud.Home;
import micam.cloud.HomeApiException;
import micam.cloud.MiCloud;
import micam.creds.CredentialStore;
import micam.creds.Credentials;

import java.io.OutputStream;
import java.io.PrintStream;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.function.Supplier;

/** One selected camera's verified MIOT night-shot property. Never emits cloud replies or IDs. */
public final class NightVisionControl {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final PrintStream OUTPUT = System.out;
    private static final Set<String> REGIONS = Set.of("cn", "sg", "de", "us", "ru", "i2");
    // MIOT instance schemas chuangmi-061a01:1 and chuangmi-061a03:1 both expose
    // camera-control/night-shot at 2/3: 0=On, 1=Off, 2=Auto. This is not the status LED.
    // Source: https://miot-spec.org/miot-spec-v2/instance?type=urn:miot-spec-v2:device:camera:0000A01C:chuangmi-061a01:1
    private static final Set<String> MODELS = Set.of("chuangmi.camera.061a01", "chuangmi.camera.061a03");
    private static final int SIID = 2;
    private static final int PIID = 3;
    private static final long CAPABILITY_TTL_MS = 24L * 60 * 60 * 1000;
    private final CredentialStore store = new CredentialStore();
    private Credentials credentials;
    private MiCloud cloud;
    private boolean renewed;

    static final class Failure extends RuntimeException {
        final int exit;
        final String reason;
        Failure(int exit, String reason) { super(reason); this.exit = exit; this.reason = reason; }
    }

    @FunctionalInterface
    interface Gateway { JsonNode call(String path, Object payload); }

    public static void main(String[] args) {
        System.setOut(new PrintStream(OutputStream.nullOutputStream()));
        System.setErr(new PrintStream(OutputStream.nullOutputStream()));
        int exit;
        try { exit = new NightVisionControl().run(args); }
        catch (Failure failure) { emit(Map.of("success", false, "reason", failure.reason)); exit = failure.exit; }
        catch (HomeApiException failure) {
            String reason = "session_expired".equals(failure.reason()) ? "authentication_required" : "night_vision_unavailable";
            emit(Map.of("success", false, "reason", reason)); exit = "authentication_required".equals(reason) ? 2 : 8;
        }
        catch (Exception failure) { emit(Map.of("success", false, "reason", "night_vision_unavailable")); exit = 8; }
        System.exit(exit);
    }

    private int run(String[] args) {
        validateArgs(args);
        String action = args[0], region = args[1], homeId = args[2], owner = args[3], did = args[4];
        try { credentials = store.load(); }
        catch (RuntimeException failure) { throw new Failure(2, "authentication_required"); }
        credentials.region = region;
        cloud = new MiCloud(credentials);
        if (!credentials.hasSession()) renew();
        verifyCapability(homeId, owner, did);
        Gateway gateway = (path, payload) -> request(() -> checkedCloudReply(cloud.call(path, payload)));
        String mode;
        if (action.equals("get")) mode = readMode(gateway, did);
        else {
            mode = args[5];
            writeMode(gateway, did, mode);
            if (!mode.equals(readMode(gateway, did))) throw new Failure(8, "night_vision_not_applied");
        }
        emit(Map.of("success", true, "mode", mode));
        return 0;
    }

    static void validateArgs(String[] args) {
        if (args.length < 2 || !REGIONS.contains(args[1])
                || !(args[0].equals("get") && args.length == 5 || args[0].equals("set") && args.length == 6)) {
            throw new Failure(7, "invalid_request");
        }
        for (int i = 2; i <= 4; i++) if (!args[i].matches("[0-9]{1,30}")) throw new Failure(7, "invalid_request");
        if (args[0].equals("set")) modeValue(args[5]);
    }

    static int modeValue(String mode) {
        return switch (mode) {
            case "on" -> 0;
            case "off" -> 1;
            case "auto" -> 2;
            default -> throw new Failure(7, "invalid_request");
        };
    }

    static String valueMode(JsonNode value) {
        if (value == null || !value.isIntegralNumber() || !value.canConvertToInt()) throw new Failure(8, "night_vision_unavailable");
        return switch (value.intValue()) {
            case 0 -> "on";
            case 1 -> "off";
            case 2 -> "auto";
            default -> throw new Failure(8, "night_vision_unavailable");
        };
    }

    static JsonNode checkedCloudReply(JsonNode response) {
        if (response == null || !response.isObject()) throw new Failure(8, "night_vision_unavailable");
        JsonNode code = response.get("code");
        String message = response.path("message").asText("");
        if (code != null && code.isIntegralNumber() && code.canConvertToInt() && code.intValue() == 3
                || message.equals("SERVICETOKEN_EXPIRED") || message.equals("serviceToken expired")) {
            throw new HomeApiException("session_expired");
        }
        if (code == null || !code.isIntegralNumber() || !code.canConvertToInt() || code.intValue() != 0) throw new Failure(8, "night_vision_rejected");
        return response;
    }

    private static JsonNode resultItem(JsonNode response, String did) {
        JsonNode results = checkedCloudReply(response).get("result"), matched = null;
        if (results == null || !results.isArray()) throw new Failure(8, "night_vision_unavailable");
        for (JsonNode result : results) {
            if (!result.isObject() || !result.path("did").asText("").equals(did)
                    || !result.path("siid").isIntegralNumber() || !result.path("siid").canConvertToInt() || result.path("siid").intValue() != SIID
                    || !result.path("piid").isIntegralNumber() || !result.path("piid").canConvertToInt() || result.path("piid").intValue() != PIID) continue;
            if (matched != null) throw new Failure(8, "night_vision_unavailable");
            matched = result;
        }
        if (matched == null) throw new Failure(8, "night_vision_unavailable");
        JsonNode code = matched.get("code");
        if (code == null || !code.isIntegralNumber() || !code.canConvertToInt() || code.intValue() != 0) throw new Failure(8, "night_vision_rejected");
        return matched;
    }

    static String readMode(Gateway gateway, String did) {
        JsonNode reply = gateway.call("/miotspec/prop/get", Map.of("datasource", 1,
                "params", List.of(Map.of("did", did, "siid", SIID, "piid", PIID))));
        return valueMode(resultItem(reply, did).get("value"));
    }

    static void writeMode(Gateway gateway, String did, String mode) {
        int value = modeValue(mode);
        JsonNode reply = gateway.call("/miotspec/prop/set", Map.of("params", List.of(
                Map.of("did", did, "siid", SIID, "piid", PIID, "value", value))));
        resultItem(reply, did);
    }

    private void verifyCapability(String homeId, String owner, String did) {
        if (cachedCapability(homeId, owner, did)) return;
        Home home = new Home(homeId, owner, "", false);
        Device device = request(() -> cloud.deviceList(home)).stream().filter(value -> did.equals(value.did()))
                .findFirst().orElseThrow(() -> new Failure(8, "night_vision_unsupported"));
        if (!MODELS.contains(device.model())) throw new Failure(8, "night_vision_unsupported");
        cacheVerifiedCapability(capabilityFile(), credentials, home, device, System.currentTimeMillis());
    }

    /** Reuses a device already verified by the stream's authoritative home-device lookup. */
    static boolean cacheVerifiedCapability(Credentials credentials, Home home, Device device) {
        return cacheVerifiedCapability(new CredentialStore().path().resolveSibling("night-vision-capability.json"),
                credentials, home, device, System.currentTimeMillis());
    }

    static boolean cacheVerifiedCapability(Path path, Credentials credentials, Home home, Device device, long now) {
        if (credentials == null || !credentials.hasSession() || credentials.region == null || !REGIONS.contains(credentials.region)
                || home == null || device == null || device.model() == null || !MODELS.contains(device.model())
                || device.did() == null || !device.did().matches("[0-9]{1,30}") || now < 0) return false;
        try {
            Map<String, Object> cached = Map.of("version", 2, "account", credentials.userId, "region", credentials.region,
                    "homeId", home.id(), "owner", home.ownerId(), "did", device.did(), "model", device.model(), "verifiedAt", now);
            atomicWrite(path, cached);
            return true;
        } catch (Exception ignored) { return false; /* Optional metadata never changes the camera policy. */ }
    }

    private Path capabilityFile() { return store.path().resolveSibling("night-vision-capability.json"); }

    private boolean cachedCapability(String homeId, String owner, String did) {
        try {
            Path path = capabilityFile();
            if (!Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS) || Files.size(path) > 4096) return false;
            JsonNode value = JSON.readTree(path.toFile());
            return matchesCapability(value, credentials, homeId, owner, did, System.currentTimeMillis());
        } catch (Exception failure) { return false; }
    }

    static boolean matchesCapability(JsonNode value, Credentials credentials, String homeId, String owner, String did, long now) {
        if (value == null || !value.isObject() || credentials == null || !credentials.hasSession()
                || credentials.region == null || !REGIONS.contains(credentials.region)) return false;
        JsonNode timestamp = value.get("verifiedAt");
        if (timestamp == null || !timestamp.isIntegralNumber() || !timestamp.canConvertToLong()) return false;
        long verifiedAt = timestamp.longValue();
        return verifiedAt >= 0 && now >= verifiedAt && now - verifiedAt < CAPABILITY_TTL_MS
                && value.path("version").isIntegralNumber() && value.path("version").canConvertToInt() && value.path("version").intValue() == 2
                && credentials.userId.equals(value.path("account").asText()) && credentials.region.equals(value.path("region").asText())
                && homeId.equals(value.path("homeId").asText()) && owner.equals(value.path("owner").asText())
                && did.equals(value.path("did").asText()) && MODELS.contains(value.path("model").asText());
    }

    private <T> T request(Supplier<T> operation) {
        try { return operation.get(); }
        catch (HomeApiException failure) {
            if (!"session_expired".equals(failure.reason()) || renewed) throw failure;
            renew();
            return operation.get();
        }
    }

    private void renew() {
        if (renewed || !credentials.canRenew()) throw new Failure(2, "authentication_required");
        renewed = true;
        try {
            cloud.login(null);
            if (!credentials.hasSession()) throw new Failure(2, "authentication_required");
            atomicWrite(store.path(), credentials);
        } catch (Exception failure) { throw new Failure(2, "authentication_required"); }
    }

    private static void atomicWrite(Path path, Object value) throws Exception {
        Files.createDirectories(path.getParent());
        Files.setPosixFilePermissions(path.getParent(), PosixFilePermissions.fromString("rwx------"));
        Path temporary = path.resolveSibling(".night-vision-" + UUID.randomUUID() + ".tmp");
        try {
            Files.createFile(temporary, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
            JSON.writeValue(temporary.toFile(), value);
            Files.move(temporary, path, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } finally { Files.deleteIfExists(temporary); }
    }

    private static synchronized void emit(Object value) {
        try { OUTPUT.println(JSON.writeValueAsString(value)); OUTPUT.flush(); } catch (Exception ignored) { }
    }
}
