package mijia.bridge;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import micam.cloud.Device;
import micam.cloud.Home;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/** Synthetic protocol fixtures only: no credentials, HTTP client or device writes. */
public final class CloudMetadataProbe {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Home HOME = new Home("9223372036854775808", "22", "", true);
    private static final String DID = "803";
    private static int checks;
    private static void check(boolean value) { checks++; if (!value) throw new AssertionError("metadata_check_failed_" + checks); }
    private static void failure(String reason, Runnable operation) {
        checks++;
        try { operation.run(); throw new AssertionError("expected_" + reason); }
        catch (CloudMetadata.Failure error) { if (!reason.equals(error.reason)) throw new AssertionError("wrong_safe_reason"); }
    }
    private static JsonNode reply(Object result) { return JSON.valueToTree(Map.of("code", 0, "result", result)); }
    private static Map<String, Object> room(String id, String name, List<String> dids) { return Map.of("id", id, "name", name, "dids", dids); }
    private static Map<String, Object> home(Object rooms) { return Map.of("id", HOME.id(), "uid", "22", "name", "共享家庭", "roomlist", rooms, "dids", List.of(DID)); }
    private static JsonNode initial(Object rooms) { return reply(Map.of("homelist", List.of(), "share_home_list", List.of(home(rooms)))); }
    private static List<Device> camera() { return List.of(new Device(DID, "云端摄像头", "chuangmi.camera.061a01", null, true)); }
    private static Map<String, Object> read(CloudMetadata.Gateway gateway) {
        return CloudMetadata.readMetadata(gateway, "123", "cn", HOME, DID, CloudMetadataProbe::camera);
    }
    public static void main(String[] args) throws Exception {
        List<String> paths = new ArrayList<>();
        JsonNode root = initial(List.of(room("4", "客厅", List.of(DID, "PRIVATE_OTHER_DEVICE")), room("5", "卧室", List.of())));
        Map<String, Object> result = read((path, payload) -> {
            paths.add(path);
            JsonNode sent = JSON.valueToTree(payload);
            check(sent.path("fetch_share").booleanValue() && sent.path("fetch_share_dev").booleanValue());
            check(sent.path("app_ver").intValue() == 9 && sent.path("limit").intValue() == 150);
            return root;
        });
        check(paths.equals(List.of("/v2/homeroom/gethome")));
        check(result.get("homeId").equals(HOME.id()) && result.get("homeOwner").equals("22"));
        check(result.get("accountId").equals("123") && result.get("region").equals("cn"));
        check(result.get("name").equals("云端摄像头") && result.get("homeName").equals("共享家庭"));
        check(result.get("roomId").equals("4") && result.get("roomName").equals("客厅"));
        check(JSON.valueToTree(result).path("rooms").size() == 2);
        check(JSON.valueToTree(result).at("/rooms/0").size() == 2);
        check(!JSON.writeValueAsString(result).contains("PRIVATE_OTHER_DEVICE"));
        Map<String, Object> unassigned = read((p, b) -> initial(List.of(room("4", "客厅", List.of()))));
        check(unassigned.get("roomId").equals("") && unassigned.get("roomName").equals(""));
        failure("metadata_incomplete", () -> read((p, b) -> reply(Map.of("share_home_list", List.of(
                Map.of("id", HOME.id(), "uid", "22", "name", "共享家庭", "roomlist", List.of()))))));

        JsonNode paged = reply(Map.of("share_home_list", List.of(home(List.of(room("4", "客厅", List.of())))),
                "has_more", true, "max_id", "cursor-one"));
        paths.clear();
        result = read((path, payload) -> {
            paths.add(path);
            if (paths.size() == 1) return paged;
            check(path.equals("/v2/homeroom/get_dev_room_page"));
            check(JSON.valueToTree(payload).path("start_id").asText().equals("cursor-one"));
            return reply(Map.of("info", List.of(Map.of("id", HOME.id(), "roomlist",
                    List.of(Map.of("id", "4", "dids", List.of(DID))))), "has_more", false));
        });
        check(paths.size() == 2 && result.get("roomId").equals("4"));
        failure("metadata_incomplete", () -> read((p, b) -> reply(Map.of("share_home_list", List.of(home(List.of())), "has_more", true))));
        failure("metadata_incomplete", () -> read((p, b) -> p.endsWith("gethome") ? paged : reply(Map.of("info", List.of(), "has_more", true, "max_id", "cursor-one"))));
        failure("metadata_incomplete", () -> read((p, b) -> p.endsWith("gethome") ? paged : reply(Map.of("info", List.of(Map.of("id", HOME.id(),
                "roomlist", List.of(Map.of("id", "9", "dids", List.of(DID)))))))));
        failure("metadata_unavailable", () -> read((p, b) -> initial(List.of(room("4", "客厅", List.of(DID)), room("5", "卧室", List.of(DID))))));
        failure("metadata_incomplete", () -> read((p, b) -> initial(List.of(Map.of("id", "4", "name", "客厅")))));
        failure("metadata_incomplete", () -> read((p, b) -> initial(List.of(room("4", "客厅", List.of()), room("4", "客厅", List.of())))));
        failure("invalid_home_selection", () -> CloudMetadata.readMetadata((p, b) -> root, "123", "cn",
                new Home(HOME.id(), "23", "", false), DID, () -> { throw new AssertionError("foreign_home_lookup"); }));
        failure("invalid_home_selection", () -> read((p, b) -> reply(Map.of("homelist", List.of(), "share_home_list", List.of()))));
        failure("camera_not_in_home", () -> CloudMetadata.readMetadata((p, b) -> root, "123", "cn", HOME, DID, List::of));
        failure("camera_not_in_home", () -> CloudMetadata.readMetadata((p, b) -> root, "123", "cn", HOME, DID,
                () -> List.of(new Device(DID, "not camera", "plug.test.v1", null, true))));
        failure("metadata_unavailable", () -> read((p, b) -> { throw new IllegalStateException("PRIVATE_TOKEN"); }));
        failure("session_expired", () -> read((p, b) -> JSON.valueToTree(Map.of("code", 3, "message", "PRIVATE_TOKEN"))));
        failure("home_request_rejected", () -> read((p, b) -> JSON.valueToTree(Map.of("code", -6, "message", "PRIVATE_TOKEN"))));
        failure("metadata_unavailable", () -> read((p, b) -> JSON.valueToTree(Map.of("code", "0", "result", Map.of()))));
        CloudMetadata.validateArgs(new String[]{"get", "cn", HOME.id(), "22", DID, "123"}); checks++;
        for (String[] invalid : List.of(new String[]{"get", "xx", HOME.id(), "22", DID, "123"},
                new String[]{"set", "cn", HOME.id(), "22", DID, "123"}, new String[]{"get", "cn", "bad", "22", DID, "123"},
                new String[]{"get", "cn", HOME.id(), "22", DID})) failure("invalid_request", () -> CloudMetadata.validateArgs(invalid));
        System.out.println(JSON.writeValueAsString(Map.of("success", true, "checks", checks)));
    }
}
