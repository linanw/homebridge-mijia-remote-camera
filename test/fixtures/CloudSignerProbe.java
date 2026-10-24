package mijia.bridge;

import com.fasterxml.jackson.databind.ObjectMapper;
import micam.cloud.CloudSigner;
import java.util.Base64;
import java.util.LinkedHashMap;

/** Deterministic, public synthetic vectors from the pinned vendor signer. */
public final class CloudSignerProbe {
    public static void main(String[] args) throws Exception {
        byte[] security = new byte[16], nonce = new byte[12];
        for (int i = 0; i < security.length; i++) security[i] = (byte) i;
        for (int i = 0; i < nonce.length; i++) nonce[i] = (byte) i;
        String ssecurity = Base64.getEncoder().encodeToString(security), encodedNonce = Base64.getEncoder().encodeToString(nonce);
        String key = CloudSigner.signedNonce(ssecurity, encodedNonce);
        if (args.length > 0 && args[0].equals("encrypt")) {
            System.out.println(CloudSigner.rc4Encrypt(key, args[1])); return;
        }
        if (args.length > 0 && args[0].equals("decrypt")) {
            System.out.println(CloudSigner.rc4Decrypt(key, args[1])); return;
        }
        LinkedHashMap<String, String> plain = new LinkedHashMap<>();
        plain.put("data", "{\"datasource\":1,\"params\":[{\"did\":\"3\",\"siid\":2,\"piid\":3}]}");
        System.out.println(new ObjectMapper().writeValueAsString(CloudSigner.encryptParams(
                "https://api.io.mi.com/app/miotspec/prop/get", "POST", key, encodedNonce, ssecurity, plain)));
    }
}
