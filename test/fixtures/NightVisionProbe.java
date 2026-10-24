package mijia.bridge;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import micam.cloud.HomeApiException;
import micam.cloud.Home;
import micam.cloud.Device;
import micam.creds.Credentials;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;

/** Synthetic cloud replies only; this harness never loads credentials or opens a connection. */
public final class NightVisionProbe {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String DID = "123456";
    private static int checks;

    private static void check(boolean condition) {
        ++checks;
        if (!condition) throw new AssertionError("night_vision_fixture_failed");
    }

    private static JsonNode reply(int value) {
        return JSON.valueToTree(Map.of("code", 0, "result", List.of(Map.of(
                "did", DID, "siid", 2, "piid", 3, "code", 0, "value", value))));
    }

    private static void failure(String reason, Runnable operation) {
        try { operation.run(); throw new AssertionError("expected_safe_failure"); }
        catch (NightVisionControl.Failure error) { check(reason.equals(error.reason)); }
    }

    public static void main(String[] args) throws Exception {
        List<String> paths = new ArrayList<>();
        List<JsonNode> payloads = new ArrayList<>();
        NightVisionControl.Gateway get = (path, payload) -> {
            paths.add(path); payloads.add(JSON.valueToTree(payload)); return reply(2);
        };
        check(NightVisionControl.readMode(get, DID).equals("auto"));
        check(paths.equals(List.of("/miotspec/prop/get")));
        JsonNode payload = payloads.getFirst();
        check(payload.path("datasource").asInt() == 1);
        check(payload.path("params").size() == 1);
        check(payload.at("/params/0/did").asText().equals(DID));
        check(payload.at("/params/0/siid").asInt() == 2 && payload.at("/params/0/piid").asInt() == 3);
        for (String mode : List.of("on", "off", "auto")) {
            int expected = mode.equals("on") ? 0 : mode.equals("off") ? 1 : 2;
            check(NightVisionControl.modeValue(mode) == expected);
            check(NightVisionControl.valueMode(JSON.valueToTree(expected)).equals(mode));
            NightVisionControl.writeMode((path, body) -> {
                check(path.equals("/miotspec/prop/set"));
                JsonNode sent = JSON.valueToTree(body);
                check(sent.size() == 1 && sent.path("params").size() == 1);
                check(sent.at("/params/0/did").asText().equals(DID));
                check(sent.at("/params/0/siid").asInt() == 2 && sent.at("/params/0/piid").asInt() == 3);
                check(sent.at("/params/0/value").asInt() == expected);
                return reply(expected);
            }, DID, mode);
        }
        failure("invalid_request", () -> NightVisionControl.modeValue("toggle"));
        for (Object invalid : List.of(3, -1, "0", true, 4294967296L)) {
            failure("night_vision_unavailable", () -> NightVisionControl.valueMode(JSON.valueToTree(invalid)));
        }
        for (String invalid : List.of("{\"code\":0}", "{\"code\":0,\"result\":[]}",
                "{\"code\":0,\"result\":[{\"did\":\"other\",\"siid\":2,\"piid\":3,\"code\":0,\"value\":0}]}",
                "{\"code\":0,\"result\":[{\"did\":\"123456\",\"siid\":2,\"piid\":6,\"code\":0,\"value\":0}]}")) {
            JsonNode response = JSON.readTree(invalid);
            failure("night_vision_unavailable", () -> NightVisionControl.readMode((p, b) -> response, DID));
        }
        JsonNode duplicate = JSON.valueToTree(Map.of("code", 0, "result", List.of(reply(0).at("/result/0"), reply(1).at("/result/0"))));
        failure("night_vision_unavailable", () -> NightVisionControl.readMode((p, b) -> duplicate, DID));
        for (Object code : List.of(-704, 4294967296L, "0")) {
            JsonNode response = JSON.valueToTree(Map.of("code", 0, "result", List.of(Map.of("did", DID, "siid", 2, "piid", 3, "code", code, "value", 0))));
            failure("night_vision_rejected", () -> NightVisionControl.readMode((p, b) -> response, DID));
        }
        for (Object code : List.of(5, 4294967296L, "0")) {
            failure("night_vision_rejected", () -> NightVisionControl.checkedCloudReply(JSON.valueToTree(Map.of("code", code))));
        }
        try {
            NightVisionControl.checkedCloudReply(JSON.valueToTree(Map.of("code", 3, "message", "PRIVATE_TOKEN")));
            throw new AssertionError("expected_session_expired");
        } catch (HomeApiException expired) { check(expired.reason().equals("session_expired")); }
        NightVisionControl.validateArgs(new String[]{"get", "cn", "1", "2", DID});
        NightVisionControl.validateArgs(new String[]{"set", "cn", "1", "2", DID, "auto"});
        failure("invalid_request", () -> NightVisionControl.validateArgs(new String[]{"set", "cn", "1", "2", DID, "PRIVATE_TOKEN"}));
        failure("invalid_request", () -> NightVisionControl.validateArgs(new String[]{"set", "cn", "1", "2", "bad-did", "on"}));
        cacheChecks();
        System.out.println(JSON.writeValueAsString(Map.of("success", true, "checks", checks)));
    }

    private static void cacheChecks() throws Exception {
        Path directory = Files.createTempDirectory("mijia-night-probe-");
        try {
            Path file = directory.resolve(".micam/night-vision-capability.json");
            Credentials credentials = new Credentials();
            credentials.userId = "77"; credentials.ssecurity = "SYNTHETIC"; credentials.serviceToken = "SYNTHETIC"; credentials.region = "cn";
            Home home = new Home("1", "2", "", false);
            Device device = new Device(DID, "", "chuangmi.camera.061a01", null, true);
            long now = 1_000_000;
            check(NightVisionControl.cacheVerifiedCapability(file, credentials, home, device, now));
            JsonNode cached = JSON.readTree(file.toFile());
            check(cached.path("version").asInt() == 2 && cached.path("region").asText().equals("cn"));
            check(NightVisionControl.matchesCapability(cached, credentials, "1", "2", DID, now + 100));
            check(!cached.has("ssecurity") && !cached.has("serviceToken") && !cached.has("passToken"));
            check(Files.getPosixFilePermissions(file).equals(PosixFilePermissions.fromString("rw-------")));
            check(Files.getPosixFilePermissions(file.getParent()).equals(PosixFilePermissions.fromString("rwx------")));
            check(!NightVisionControl.matchesCapability(cached, credentials, "3", "2", DID, now));
            check(!NightVisionControl.matchesCapability(cached, credentials, "1", "3", DID, now));
            check(!NightVisionControl.matchesCapability(cached, credentials, "1", "2", "999", now));
            check(!NightVisionControl.matchesCapability(cached, credentials, "1", "2", DID, now - 1));
            check(!NightVisionControl.matchesCapability(cached, credentials, "1", "2", DID, now + 86_400_000));
            credentials.region = "sg";
            check(!NightVisionControl.matchesCapability(cached, credentials, "1", "2", DID, now));
            check(NightVisionControl.cacheVerifiedCapability(file, credentials, home, device, now));
            JsonNode singapore = JSON.readTree(file.toFile());
            check(NightVisionControl.matchesCapability(singapore, credentials, "1", "2", DID, now));
            credentials.region = "cn";
            check(!NightVisionControl.matchesCapability(singapore, credentials, "1", "2", DID, now));
            credentials.userId = "88";
            check(!NightVisionControl.matchesCapability(cached, credentials, "1", "2", DID, now));
            credentials.userId = "77";
            String before = Files.readString(file);
            check(!NightVisionControl.cacheVerifiedCapability(file, credentials, home,
                    new Device(DID, "", "chuangmi.camera.unverified", null, true), now));
            check(Files.readString(file).equals(before));
            credentials.region = null;
            check(!NightVisionControl.cacheVerifiedCapability(file, credentials, home, device, now));
            check(!NightVisionControl.matchesCapability(cached, credentials, "1", "2", DID, now));
            try (var entries = Files.list(file.getParent())) { check(entries.count() == 1); }
        } finally {
            try (var entries = Files.walk(directory)) {
                for (Path entry : entries.sorted(Comparator.reverseOrder()).toList()) Files.deleteIfExists(entry);
            }
        }
    }
}
