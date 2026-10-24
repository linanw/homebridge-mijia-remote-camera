package mijia.bridge;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import micam.cloud.Device;
import micam.cloud.Home;

import java.math.BigInteger;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Independent fake cloud protocol: synthetic names, accounts and DID; never opens a network client. */
public final class CloudMetadataWriteProbe {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String DID = "803";
    private static int checks;
    private static int singleWrites;
    private static void check(boolean value) { checks++; if (!value) throw new AssertionError("write_check_failed_" + checks); }
    private static void failure(String expected, Runnable operation) {
        checks++;
        try { operation.run(); throw new AssertionError("expected_safe_failure"); }
        catch (CloudMetadata.Failure failure) { if (!expected.equals(failure.reason)) throw new AssertionError("incorrect_safe_failure"); }
    }
    private static JsonNode reply(Object result) { return JSON.valueToTree(Map.of("code", 0, "result", result)); }
    private static final class Cloud implements CloudMetadata.Gateway {
        final String owner;
        final Home home;
        String name = "云端摄像头", room = "4";
        boolean apply = true, loseWriteReply, badReadback, badDeviceReadback, changedRooms;
        Object replyCode = 0;
        int reads, writes, deviceReads, guards;
        int guardFailure;
        final List<String> paths = new ArrayList<>();
        Cloud() { this("22"); }
        Cloud(String owner) { this.owner = owner; home = new Home("202", owner, "家庭", false); }
        @Override public JsonNode call(String path, Object payload) {
            paths.add(path);
            JsonNode sent = JSON.valueToTree(payload);
            if (path.equals("/v2/homeroom/gethome")) {
                reads++;
                if (writes > 0 && badReadback) throw new IllegalStateException("PRIVATE_READBACK_TOKEN");
                List<Object> rooms = new ArrayList<>();
                rooms.add(Map.of("id", "4", "name", "客厅", "dids", room.equals("4") ? List.of(DID) : List.of()));
                rooms.add(Map.of("id", "5", "name", changedRooms ? "已变更卧室" : "卧室", "dids", room.equals("5") ? List.of(DID) : List.of()));
                // This room ID is intentionally the same as the home ID: never allow a root/default-room move.
                rooms.add(Map.of("id", home.id(), "name", "默认", "dids", List.of()));
                return reply(Map.of("homelist", List.of(Map.of("id", home.id(), "uid", owner, "name", "家庭",
                        "roomlist", rooms, "dids", List.of(DID))), "share_home_list", List.of()));
            }
            writes++; singleWrites++;
            check(writes == 1);
            if (path.equals("/device/rename")) {
                check(sent.size() == 4 && sent.has("app_version") && sent.has("newName") && sent.has("did") && sent.has("is_group"));
                check(sent.get("app_version").isInt() && sent.get("app_version").intValue() == 1);
                check(sent.get("did").isTextual() && sent.get("did").asText().equals(DID));
                check(sent.get("is_group").isBoolean() && !sent.get("is_group").booleanValue());
                if (apply) name = sent.get("newName").asText();
            } else if (path.equals("/homeroom/bind_device_to_room")) {
                check(sent.size() == 3 && sent.has("id") && sent.has("did") && sent.has("home_owner"));
                check(sent.get("id").isTextual() && sent.get("id").asText().equals("5"));
                check(sent.get("did").isTextual() && sent.get("did").asText().equals(DID));
                check(sent.get("home_owner").isIntegralNumber() && sent.get("home_owner").bigIntegerValue().equals(new BigInteger(owner)));
                if (apply) room = sent.get("id").asText();
            } else throw new AssertionError("mutation_path_not_whitelisted");
            if (loseWriteReply) throw new IllegalStateException("PRIVATE_WRITE_URL?serviceToken=private");
            // Rename may acknowledge with a scalar result; the verified readback is decisive.
            return JSON.valueToTree(Map.of("code", replyCode, "result", true));
        }
        List<Device> devices() {
            deviceReads++;
            if (writes > 0 && badDeviceReadback) throw new IllegalStateException("PRIVATE_DEVICE_TOKEN");
            return List.of(new Device(DID, name, "chuangmi.camera.061a01", null, true));
        }
        void guard() { if (++guards == guardFailure) throw new CloudMetadata.Failure("metadata_conflict"); }
        Map<String, Object> read() { return CloudMetadata.readMetadata(this, owner, "cn", home, DID, this::devices); }
        String baseline() { String value = CloudMetadata.fingerprint(read()); reads = 0; deviceReads = 0; paths.clear(); return value; }
        Map<String, Object> write(String action, String baseline, String value) {
            return CloudMetadata.writeMetadata(this, owner, "cn", home, DID, this::devices, action, baseline, value, this::guard);
        }
    }
    public static void main(String[] args) throws Exception {
        Cloud cloud = new Cloud();
        String baseline = cloud.baseline();
        Map<String, Object> result = cloud.write("rename", baseline, "新的摄像头名称");
        check(result.get("confirmed").equals(true) && result.get("name").equals("新的摄像头名称"));
        check(result.get("roomId").equals("4") && result.get("deviceId").equals(DID));
        check(cloud.reads == 2 && cloud.deviceReads == 2 && cloud.guards == 4 && cloud.writes == 1);
        check(cloud.paths.equals(List.of("/v2/homeroom/gethome", "/device/rename", "/v2/homeroom/gethome")));
        cloud = new Cloud("9223372036854775808"); baseline = cloud.baseline();
        result = cloud.write("move", baseline, "5");
        check(result.get("confirmed").equals(true) && result.get("roomId").equals("5") && result.get("roomName").equals("卧室"));
        check(result.get("name").equals("云端摄像头") && cloud.writes == 1 && cloud.reads == 2);
        Cloud longName = new Cloud(); String longBaseline = longName.baseline();
        String unchangedUnicode = "摄像头".repeat(52) + "\ud83d\udcf7\ud83d\udcf7";
        check(unchangedUnicode.length() == 160);
        check(longName.write("rename", longBaseline, unchangedUnicode).get("name").equals(unchangedUnicode));
        check(longName.writes == 1);

        for (String action : List.of("rename", "move")) {
            for (String mode : List.of("ignored", "lost_reply", "readback", "device_readback", "nonzero", "string_code")) {
                Cloud probe = new Cloud(); String expected = probe.baseline();
                switch (mode) {
                    case "ignored" -> probe.apply = false;
                    case "lost_reply" -> probe.loseWriteReply = true;
                    case "readback" -> probe.badReadback = true;
                    case "device_readback" -> probe.badDeviceReadback = true;
                    case "nonzero" -> probe.replyCode = -6;
                    case "string_code" -> probe.replyCode = "0";
                }
                failure(mode.equals("ignored") ? "metadata_not_applied" : "metadata_unconfirmed",
                        () -> probe.write(action, expected, action.equals("rename") ? "新名称" : "5"));
                check(probe.writes == 1 && probe.reads <= 2);
                if (mode.equals("lost_reply")) check(!probe.name.equals("云端摄像头") || !probe.room.equals("4"));
            }
        }
        Cloud stale = new Cloud(); String staleBaseline = stale.baseline(); stale.name = "其他客户端已改名";
        failure("metadata_conflict", () -> stale.write("rename", staleBaseline, "不应覆盖")); check(stale.writes == 0);
        Cloud roomsChanged = new Cloud(); String oldRooms = roomsChanged.baseline(); roomsChanged.changedRooms = true;
        failure("metadata_conflict", () -> roomsChanged.write("move", oldRooms, "5")); check(roomsChanged.writes == 0);
        for (int guardFailure = 1; guardFailure <= 4; guardFailure++) {
            Cloud switched = new Cloud(); String guardBaseline = switched.baseline(); switched.guardFailure = guardFailure;
            failure(guardFailure < 3 ? "metadata_conflict" : "metadata_unconfirmed",
                    () -> switched.write("rename", guardBaseline, "新名称"));
            check(switched.writes == (guardFailure < 3 ? 0 : 1));
        }
        Cloud rejected = new Cloud(); String rejectedBaseline = rejected.baseline();
        for (String value : List.of("", "999", "202")) {
            failure("invalid_request", () -> rejected.write("move", rejectedBaseline, value)); check(rejected.writes == 0);
        }
        for (String value : List.of("", " name ", "name\nsecret", "x".repeat(161), "\ud800", "\udc00",
                "\u00a0name", "name\u00a0", "\ufeffname", "name\u2007")) {
            failure("invalid_request", () -> rejected.write("rename", rejectedBaseline, value)); check(rejected.writes == 0);
        }
        failure("invalid_request", () -> rejected.write("roomRename", rejectedBaseline, "unsupported"));
        failure("invalid_request", () -> rejected.write("/device/rename", rejectedBaseline, "unsupported"));
        failure("invalid_request", () -> rejected.write("rename", "bad_revision", "new"));
        failure("metadata_not_owner", () -> CloudMetadata.writeMetadata(rejected, "123", "cn", rejected.home, DID,
                rejected::devices, "rename", rejectedBaseline, "new", rejected::guard));
        check(rejected.writes == 0);
        failure("invalid_home_selection", () -> CloudMetadata.writeMetadata(rejected, "22", "cn", new Home("999", "22", "", false), DID,
                rejected::devices, "rename", rejectedBaseline, "new", rejected::guard));
        failure("camera_not_in_home", () -> CloudMetadata.writeMetadata(rejected, "22", "cn", rejected.home, "999",
                rejected::devices, "rename", rejectedBaseline, "new", rejected::guard));
        failure("invalid_request", () -> CloudMetadata.writeMetadata(rejected, "22", "https://untrusted", rejected.home, DID,
                rejected::devices, "rename", rejectedBaseline, "new", rejected::guard));
        check(rejected.writes == 0);
        check(CloudMetadata.fingerprint(rejected.read()).equals(args[0]));
        check(CloudMetadata.fingerprint(longName.read()).equals(args[1]));
        for (String action : Set.of("rename", "move")) {
            CloudMetadata.validateArgs(new String[]{action, "cn", "202", "22", DID, "22", rejectedBaseline,
                    action.equals("rename") ? "new" : "5"}); checks++;
        }
        System.out.println(JSON.writeValueAsString(Map.of("success", true, "checks", checks, "singleWrites", singleWrites)));
    }
}
