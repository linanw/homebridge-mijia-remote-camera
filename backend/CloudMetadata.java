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
import java.math.BigInteger;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.charset.StandardCharsets;
import java.nio.charset.CodingErrorAction;
import java.nio.ByteBuffer;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.function.Supplier;

/** Selected-camera metadata reads and explicit, guarded, single-dispatch cloud writes. */
public final class CloudMetadata {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final PrintStream OUTPUT = System.out;
    private static final Set<String> REGIONS = Set.of("cn", "sg", "de", "us", "ru", "i2");
    private static final Set<String> SAFE_REASONS = Set.of("session_expired", "authentication_required",
            "invalid_home_selection", "invalid_home_response", "missing_home_owner", "invalid_device_response",
            "device_pagination_incomplete", "home_request_failed", "home_request_rejected");

    static final class Failure extends RuntimeException {
        final String reason;
        Failure(String reason) { super(reason); this.reason = reason; }
    }
    @FunctionalInterface
    interface Gateway { JsonNode call(String path, Object payload); }
    private static final class Room {
        final String id;
        String name;
        final Set<String> dids = new TreeSet<>();
        Room(String id, String name) { this.id = id; this.name = name; }
    }

    public static void main(String[] args) {
        System.setOut(new PrintStream(OutputStream.nullOutputStream()));
        System.setErr(new PrintStream(OutputStream.nullOutputStream()));
        int exit;
        try { exit = run(args); }
        catch (Failure failure) { emit(Map.of("success", false, "reason", failure.reason)); exit = auth(failure.reason) ? 2 : 7; }
        catch (HomeApiException failure) {
            String reason = SAFE_REASONS.contains(failure.reason()) ? failure.reason() : "metadata_unavailable";
            emit(Map.of("success", false, "reason", reason)); exit = auth(reason) ? 2 : 7;
        }
        catch (Exception failure) { emit(Map.of("success", false, "reason", "metadata_unavailable")); exit = 7; }
        System.exit(exit);
    }
    private static boolean auth(String reason) { return reason.equals("authentication_required") || reason.equals("session_expired"); }

    static int run(String[] args) {
        validateArgs(args);
        Credentials credentials;
        try { credentials = new CredentialStore().load(); }
        catch (RuntimeException invalid) { throw new Failure("authentication_required"); }
        // This helper never renews a login or writes credentials. Bind before any cloud request.
        if (!credentials.hasSession() || !args[1].equals(credentials.region)
                || !args[5].equals(credentials.userId)) throw new Failure("authentication_required");
        MiCloud cloud = new MiCloud(credentials);
        Home selected = new Home(args[2], args[3], "", false);
        Map<String, Object> value;
        if (args[0].equals("get")) {
            value = readMetadata(cloud::call, args[5], args[1], selected, args[4], () -> cloud.deviceList(selected));
        } else {
            String action = args[0].equals("rename64") ? "rename" : args[0];
            String requested = args[0].equals("rename64") ? decodeRename(args[7]) : args[7];
            String account = credentials.userId, region = credentials.region;
            String security = credentials.ssecurity, token = credentials.serviceToken;
            Runnable sessionGuard = () -> {
                Credentials current;
                try { current = new CredentialStore().load(); }
                catch (RuntimeException invalid) { throw new Failure("metadata_conflict"); }
                if (!current.hasSession() || !Objects.equals(account, current.userId) || !Objects.equals(region, current.region)
                        || !Objects.equals(security, current.ssecurity) || !Objects.equals(token, current.serviceToken)) {
                    throw new Failure("metadata_conflict");
                }
                assertStoredSelection(args[1], args[2], args[3], args[4]);
            };
            value = writeMetadata(cloud::call, args[5], args[1], selected, args[4], () -> cloud.deviceList(selected),
                    action, args[6], requested, sessionGuard);
        }
        value.put("success", true);
        emit(value);
        return 0;
    }

    static void validateArgs(String[] args) {
        if (args.length < 2 || !REGIONS.contains(args[1])
                || !(args[0].equals("get") && args.length == 6
                || Set.of("rename", "rename64", "move").contains(args[0]) && args.length == 8)) throw new Failure("invalid_request");
        for (int index = 2; index < 6; index++) {
            if (!args[index].matches("(0|[1-9][0-9]{0,29})")) throw new Failure("invalid_request");
        }
        if (args.length == 8) {
            validateWrite(args[0].equals("rename64") ? "rename" : args[0], args[6],
                    args[0].equals("rename64") ? decodeRename(args[7]) : args[7]);
        }
    }

    /** ASCII-only process transport avoids locale-dependent native argv decoding. */
    static String decodeRename(String encoded) {
        if (encoded == null || encoded.isEmpty() || encoded.length() > 640) throw new Failure("invalid_request");
        try {
            byte[] bytes = Base64.getDecoder().decode(encoded);
            if (!Base64.getEncoder().encodeToString(bytes).equals(encoded)) throw new Failure("invalid_request");
            return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
        } catch (Exception invalid) { throw new Failure("invalid_request"); }
    }

    private static void validateWrite(String action, String baseline, String requested) {
        if (!Set.of("rename", "move").contains(action) || baseline == null || !baseline.matches("[a-f0-9]{64}")
                || requested == null) throw new Failure("invalid_request");
        if (action.equals("move")) {
            if (!requested.matches("(0|[1-9][0-9]{0,29})")) throw new Failure("invalid_request");
        } else if (requested.isEmpty() || requested.length() > 160
                || trimBoundary(requested.codePointAt(0)) || trimBoundary(requested.codePointBefore(requested.length()))
                || requested.chars().anyMatch(Character::isISOControl)
                || requested.codePoints().anyMatch(value -> value >= 0xd800 && value <= 0xdfff)) {
            throw new Failure("invalid_request");
        }
    }

    private static boolean trimBoundary(int value) {
        return Character.isWhitespace(value) || Character.isSpaceChar(value) || value == 0xfeff;
    }

    private static void assertStoredSelection(String region, String home, String owner, String did) {
        Path file = Path.of(System.getProperty("user.home"), "selection.json");
        try {
            if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS)) throw new Failure("metadata_conflict");
            JsonNode selected;
            try (var input = Files.newInputStream(file, LinkOption.NOFOLLOW_LINKS)) {
                byte[] bytes = input.readNBytes(16385);
                if (bytes.length > 16384) throw new Failure("metadata_conflict");
                selected = JSON.readTree(bytes);
            }
            if (selected == null || !selected.isObject() || !region.equals(selected.path("region").asText())
                    || !home.equals(selected.path("homeId").asText()) || !owner.equals(selected.path("homeOwner").asText())
                    || !did.equals(selected.path("deviceId").asText())) throw new Failure("metadata_conflict");
        } catch (Exception invalid) { throw new Failure("metadata_conflict"); }
    }

    /** Cross-language revision guard: JSON array layout matches metadataFingerprint in the Node runtime. */
    static String fingerprint(Map<String, Object> value) {
        try {
            List<Object> rooms = new ArrayList<>();
            for (Object item : (List<?>) value.get("rooms")) {
                Map<?, ?> room = (Map<?, ?>) item;
                rooms.add(List.of(room.get("id"), room.get("name")));
            }
            // Jackson's UTF-8 byte generator escapes supplementary characters, unlike JSON.stringify.
            // Its String generator preserves surrogate pairs; encode that result once as UTF-8.
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(JSON.writeValueAsString(List.of(
                    value.get("deviceId"), value.get("homeId"), value.get("homeOwner"), value.get("region"), value.get("name"),
                    value.get("homeName"), value.get("roomId"), value.get("roomName"), rooms)).getBytes(StandardCharsets.UTF_8)));
        } catch (Exception invalid) { throw new Failure("metadata_unavailable"); }
    }

    /** Protocol fields established by static inspection of the official Mi Home 11.8.707 APK. */
    static Map<String, Object> writeMetadata(Gateway gateway, String accountId, String region, Home selected,
            String did, Supplier<List<Device>> deviceLookup, String action, String baseline, String requested,
            Runnable sessionGuard) {
        validateWrite(action, baseline, requested);
        if (!REGIONS.contains(region) || selected == null || accountId == null || did == null
                || !accountId.matches("(0|[1-9][0-9]{0,29})") || !did.matches("(0|[1-9][0-9]{0,29})")) {
            throw new Failure("invalid_request");
        }
        if (!accountId.equals(selected.ownerId())) throw new Failure("metadata_not_owner");
        sessionGuard.run();
        Map<String, Object> before = readMetadata(gateway, accountId, region, selected, did, deviceLookup);
        if (!fingerprint(before).equals(baseline)) throw new Failure("metadata_conflict");
        if (action.equals("move")) {
            boolean existing = ((List<?>) before.get("rooms")).stream()
                    .anyMatch(value -> requested.equals(((Map<?, ?>) value).get("id")));
            // Only an existing room in this exact home is supported; no home-root move or creation.
            if (!existing || requested.equals(selected.id())) throw new Failure("invalid_request");
        }
        sessionGuard.run();
        String path = action.equals("rename") ? "/device/rename" : "/homeroom/bind_device_to_room";
        Map<String, Object> payload = action.equals("rename")
                ? Map.of("app_version", 1, "newName", requested, "did", did, "is_group", false)
                : Map.of("id", requested, "did", did, "home_owner", new BigInteger(selected.ownerId()));
        Map<String, Object> after;
        // From dispatch onward, any ambiguous failure may have occurred after the server committed.
        // Never retry a write, renew the login, or report that a timed-out mutation was not applied.
        try {
            JsonNode response = gateway.call(path, payload);
            if (response == null || !response.isObject() || !response.path("code").isIntegralNumber()
                    || !response.path("code").canConvertToInt() || response.path("code").intValue() != 0) {
                throw new Failure("metadata_unconfirmed");
            }
            sessionGuard.run();
            after = readMetadata(gateway, accountId, region, selected, did, deviceLookup);
            sessionGuard.run();
        } catch (RuntimeException uncertain) { throw new Failure("metadata_unconfirmed"); }
        if (!requested.equals(after.get(action.equals("rename") ? "name" : "roomId"))) {
            throw new Failure("metadata_not_applied");
        }
        after.put("confirmed", true);
        return after;
    }

    /** Schema and expansion follow XiaoMi/ha_xiaomi_home miot_cloud.py get_homeinfos_async. */
    static Map<String, Object> readMetadata(Gateway gateway, String accountId, String region, Home selected,
            String did, Supplier<List<Device>> deviceLookup) {
        JsonNode root = result(gateway, "/v2/homeroom/gethome", Map.of("limit", 150,
                "fetch_share", true, "fetch_share_dev", true, "plat_form", 0, "app_ver", 9));
        JsonNode home = null;
        for (String source : List.of("homelist", "share_home_list")) {
            JsonNode homes = root.get(source);
            if (homes == null || homes.isNull()) continue;
            if (!homes.isArray() || homes.size() > 1000) throw new Failure("invalid_home_response");
            for (JsonNode candidate : homes) {
                if (!candidate.isObject()) throw new Failure("invalid_home_response");
                if (!selected.id().equals(identifier(candidate.get("id")))) continue;
                JsonNode owner = candidate.hasNonNull("uid") ? candidate.get("uid") : candidate.get("home_owner");
                String ownerId;
                if (owner == null || owner.isNull()) {
                    if (source.equals("share_home_list")) throw new Failure("invalid_home_response");
                    ownerId = accountId;
                } else ownerId = identifier(owner);
                if (!selected.ownerId().equals(ownerId)) continue;
                if (home != null) throw new Failure("invalid_home_response");
                home = candidate;
            }
        }
        if (home == null) throw new Failure("invalid_home_selection");
        String homeName = text(home.get("name"));
        Set<String> homeDids = new TreeSet<>();
        appendHomeDids(homeDids, home.get("dids"));
        Map<String, Room> rooms = new TreeMap<>();
        appendRooms(rooms, home.get("roomlist"), true);
        Set<String> cursors = new HashSet<>();
        JsonNode page = root;
        int pages = 0;
        while (more(page)) {
            if (++pages > 100) throw new Failure("metadata_incomplete");
            JsonNode cursorNode = page.get("max_id");
            if (cursorNode == null || !(cursorNode.isTextual() || cursorNode.isIntegralNumber())) throw new Failure("metadata_incomplete");
            String cursor = cursorNode.asText();
            if (cursor.isBlank() || cursor.length() > 128 || cursor.chars().anyMatch(Character::isISOControl)
                    || !cursors.add(cursor)) throw new Failure("metadata_incomplete");
            page = result(gateway, "/v2/homeroom/get_dev_room_page", Map.of("start_id", cursor, "limit", 150));
            JsonNode homes = page.get("info");
            if (homes == null || !homes.isArray() || homes.size() > 1000) throw new Failure("metadata_incomplete");
            for (JsonNode candidate : homes) {
                if (!candidate.isObject()) throw new Failure("metadata_incomplete");
                if (selected.id().equals(identifier(candidate.get("id")))) {
                    appendHomeDids(homeDids, candidate.get("dids"));
                    appendRooms(rooms, candidate.get("roomlist"), false);
                }
            }
        }
        Device camera = null;
        List<Device> devices;
        try { devices = deviceLookup.get(); }
        catch (HomeApiException known) { throw known; }
        catch (RuntimeException ignored) { throw new Failure("metadata_unavailable"); }
        if (devices == null || devices.size() > 20000) throw new Failure("invalid_device_response");
        for (Device device : devices) {
            if (!did.equals(device.did())) continue;
            if (camera != null || !device.isCamera()) throw new Failure("camera_not_in_home");
            camera = device;
        }
        if (camera == null) throw new Failure("camera_not_in_home");
        String roomId = "", roomName = "";
        int total = 0;
        List<Map<String, Object>> outputRooms = new ArrayList<>();
        for (Room room : rooms.values()) {
            if (room.name == null) throw new Failure("metadata_incomplete");
            total += room.dids.size();
            if (total > 20000) throw new Failure("metadata_incomplete");
            if (room.dids.contains(did)) {
                if (!roomId.isEmpty()) throw new Failure("metadata_unavailable");
                roomId = room.id; roomName = room.name;
            }
            outputRooms.add(Map.of("id", room.id, "name", room.name));
        }
        // Absence from every room is only "unassigned" when the home-level DID
        // expansion explicitly includes this camera. Missing metadata is not a room move.
        if (roomId.isEmpty() && !homeDids.contains(did)) throw new Failure("metadata_incomplete");
        Map<String, Object> output = new LinkedHashMap<>();
        output.put("accountId", accountId); output.put("region", region);
        output.put("homeId", selected.id()); output.put("homeOwner", selected.ownerId()); output.put("deviceId", did);
        output.put("name", text(JSON.valueToTree(camera.name()))); output.put("homeName", homeName);
        output.put("roomId", roomId); output.put("roomName", roomName); output.put("rooms", outputRooms);
        return output;
    }

    private static void appendHomeDids(Set<String> dids, JsonNode list) {
        if (list == null || list.isNull()) return;
        if (!list.isArray() || list.size() > 20000) throw new Failure("metadata_incomplete");
        for (JsonNode value : list) {
            if (!(value.isTextual() || value.isIntegralNumber())) throw new Failure("metadata_incomplete");
            String did = value.asText();
            if (did.isBlank() || did.length() > 128 || did.chars().anyMatch(Character::isISOControl)) throw new Failure("metadata_incomplete");
            dids.add(did);
        }
        if (dids.size() > 20000) throw new Failure("metadata_incomplete");
    }

    private static void appendRooms(Map<String, Room> rooms, JsonNode list, boolean initial) {
        if (list == null || !list.isArray()) throw new Failure("metadata_incomplete");
        Set<String> seen = new HashSet<>();
        for (JsonNode value : list) {
            if (!value.isObject()) throw new Failure("metadata_incomplete");
            String id = identifier(value.get("id"));
            if (!seen.add(id)) throw new Failure("metadata_incomplete");
            String name = value.has("name") ? text(value.get("name")) : null;
            if (initial && name == null) throw new Failure("metadata_incomplete");
            Room room = rooms.computeIfAbsent(id, key -> new Room(key, name));
            if (name != null && room.name != null && !name.equals(room.name)) throw new Failure("metadata_incomplete");
            if (name != null) room.name = name;
            JsonNode dids = value.get("dids");
            if (dids == null || !dids.isArray() || dids.size() > 20000) throw new Failure("metadata_incomplete");
            for (JsonNode did : dids) {
                if (!(did.isTextual() || did.isIntegralNumber())) throw new Failure("metadata_incomplete");
                String text = did.asText();
                if (text.isBlank() || text.length() > 128 || text.chars().anyMatch(Character::isISOControl)) throw new Failure("metadata_incomplete");
                room.dids.add(text);
            }
            if (room.dids.size() > 20000 || rooms.size() > 1000) throw new Failure("metadata_incomplete");
        }
    }
    private static boolean more(JsonNode value) {
        JsonNode more = value.get("has_more");
        if (more == null || more.isNull()) return false;
        if (more.isBoolean()) return more.booleanValue();
        if (more.isIntegralNumber() && more.canConvertToInt() && (more.intValue() == 0 || more.intValue() == 1)) return more.intValue() == 1;
        throw new Failure("metadata_incomplete");
    }
    private static String identifier(JsonNode value) {
        if (value == null || !(value.isTextual() || value.isIntegralNumber()) || !value.asText().matches("[0-9]{1,30}")) throw new Failure("invalid_home_response");
        return new BigInteger(value.asText()).toString();
    }
    private static String text(JsonNode value) {
        if (value == null || !value.isTextual() || value.textValue().length() > 1024) throw new Failure("metadata_unavailable");
        String text = value.textValue().replaceAll("\\p{Cc}", " ").strip();
        return text.substring(0, Math.min(text.length(), 160));
    }
    private static JsonNode result(Gateway gateway, String path, Object payload) {
        JsonNode response;
        try { response = gateway.call(path, payload); }
        catch (HomeApiException known) { throw known; }
        catch (RuntimeException ignored) { throw new Failure("metadata_unavailable"); }
        if (response == null || !response.isObject()) throw new Failure("metadata_unavailable");
        JsonNode code = response.get("code");
        String message = response.path("message").asText("");
        if (code != null && code.isIntegralNumber() && code.canConvertToInt() && code.intValue() == 3
                || message.equals("SERVICETOKEN_EXPIRED") || message.equals("serviceToken expired")) throw new Failure("session_expired");
        if (code == null || !code.isIntegralNumber() || !code.canConvertToInt()) throw new Failure("metadata_unavailable");
        if (code.intValue() != 0) throw new Failure("home_request_rejected");
        JsonNode result = response.get("result");
        if (result == null || !result.isObject()) throw new Failure("metadata_unavailable");
        return result;
    }
    private static synchronized void emit(Object value) {
        try {
            // Container stdout may use US-ASCII even when the process default charset is UTF-8.
            OUTPUT.write((JSON.writeValueAsString(value) + "\n").getBytes(StandardCharsets.UTF_8));
            OUTPUT.flush();
        } catch (Exception ignored) { }
    }
}
