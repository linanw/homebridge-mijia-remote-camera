package mijia.bridge;

import java.lang.reflect.Method;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Exercises production JSON output with synthetic Unicode metadata and no cloud calls. */
public final class CloudMetadataOutputProbe {
    public static void main(String[] args) throws Exception {
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("deviceId", "803"); value.put("homeId", "202"); value.put("homeOwner", "22");
        value.put("region", "cn"); value.put("name", "米家摄像头📷"); value.put("homeName", "家庭🏡");
        value.put("roomId", "4"); value.put("roomName", "客厅🛋️");
        value.put("rooms", List.of(Map.of("id", "4", "name", "客厅🛋️"), Map.of("id", "5", "name", "卧室🛏️")));
        if (args.length > 0) {
            CloudMetadata.validateArgs(args);
            value.put("name", CloudMetadata.decodeRename(args[7]));
        }
        value.put("fingerprint", CloudMetadata.fingerprint(value));
        value.put("stdoutEncoding", System.out.charset().name());
        value.put("nativeEncoding", System.getProperty("native.encoding"));
        Method emit = CloudMetadata.class.getDeclaredMethod("emit", Object.class);
        emit.setAccessible(true);
        emit.invoke(null, value);
    }
}
