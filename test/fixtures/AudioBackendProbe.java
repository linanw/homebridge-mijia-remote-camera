package mijia.bridge;

import micam.miss.MediaPacket;
import micam.miss.MissClient;
import micam.miss.MissCrypto;
import micam.pppp.Frame;
import micam.pppp.Msg;
import micam.pppp.PpppConnection;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URI;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

/** Synthetic local fixtures only. Never loads user credentials or contacts a real camera. */
public final class AudioBackendProbe {
    private static void check(boolean value) { if (!value) throw new AssertionError("audio fixture assertion"); }
    private static byte[] read() throws IOException { return System.in.readAllBytes(); }
    public static void main(String[] args) throws Exception {
        switch (args[0]) {
            case "encode" -> {
                byte[] bytes = read();
                for (int i = 0; i < bytes.length; i += 2)
                    System.out.write(AudioCodecs.encodeAlaw((short) ((bytes[i] & 255) | (bytes[i + 1] << 8))));
            }
            case "decode" -> System.out.write(AudioCodecs.pcmFromAlaw(read()));
            case "ogg-copy" -> {
                AudioCodecs.OggReader input = new AudioCodecs.OggReader(System.in);
                AudioCodecs.OggWriter output = new AudioCodecs.OggWriter(1234);
                System.out.write(output.headers());
                byte[] packet; while ((packet = input.next()) != null) System.out.write(output.packet(packet));
            }
            case "unit" -> unit();
            case "transport" -> transport();
            default -> throw new IllegalArgumentException("fixture mode");
        }
        System.out.flush();
    }
    private static void unit() throws Exception {
        byte[] bytes = new byte[256]; for (int i = 0; i < bytes.length; i++) bytes[i] = (byte) i;
        check(AudioCodecs.pcmFromAlaw(bytes).length == 512);
        for (byte a : bytes) check(AudioCodecs.encodeAlaw(AudioCodecs.decodeAlaw(a)) == a);
        ByteBuffer wav = ByteBuffer.wrap(AudioCodecs.wavHeader(16000)).order(ByteOrder.LITTLE_ENDIAN);
        check(wav.getInt(24) == 16000 && wav.getShort(22) == 1 && wav.getShort(34) == 16);
        check(AudioStreamServer.Format.of(new MediaPacket(1027, 0, 0, 0, new byte[]{0})).sampleRate() == 8000);
        check(AudioStreamServer.Format.of(new MediaPacket(1027, 0, 8, 0, new byte[]{0})).sampleRate() == 16000);
        check(AudioStreamServer.Format.of(new MediaPacket(4, 0, 0, 0, new byte[]{0})) == null);
        byte[] packet = {(byte) 0xFC, (byte) 0xFF, (byte) 0xFE}; // 20ms Opus comfort packet
        check(AudioCodecs.opusSamples(packet) == 960);
        AudioCodecs.OggWriter writer = new AudioCodecs.OggWriter(5);
        ByteArrayOutputStream ogg = new ByteArrayOutputStream();
        ogg.write(writer.headers()); ogg.write(writer.packet(packet));
        AudioCodecs.OggReader reader = new AudioCodecs.OggReader(new ByteArrayInputStream(ogg.toByteArray()));
        check(Arrays.equals(reader.next(), packet) && reader.next() == null);
        byte[] corrupt = ogg.toByteArray(); corrupt[corrupt.length - 1] ^= 1;
        try { new AudioCodecs.OggReader(new ByteArrayInputStream(corrupt)).next(); throw new AssertionError("CRC accepted"); }
        catch (IOException expected) { check(expected.getMessage().equals("ogg_crc")); }
        byte[] invalid = new byte[AudioCodecs.MAX_PACKET + 1];
        check(AudioStreamServer.Format.of(new MediaPacket(1032, 0, 0, 0, invalid)) == null);
        try { AudioCodecs.opusSamples(new byte[]{3}); throw new AssertionError("truncated TOC accepted"); }
        catch (IllegalArgumentException expected) { }
        byte[] encrypted = {9, 8, 7, 6, 5, 4, 3, 2, 1};
        byte[] message = Talkback.mediaMessage(1027, 123456, encrypted);
        ByteBuffer header = ByteBuffer.wrap(message);
        check(header.getInt() == 32 + encrypted.length);
        header.order(ByteOrder.LITTLE_ENDIAN);
        check(header.getInt() == encrypted.length && header.getInt() == 1027);
        check(header.getInt() == 0 && header.getInt() == 0 && header.getLong() == 123456);
        check(Arrays.equals(Arrays.copyOfRange(message, 36, message.length), encrypted));
        System.out.println("ok");
    }
    private static HttpURLConnection request(int port, String path) throws Exception {
        HttpURLConnection http = (HttpURLConnection) URI.create("http://127.0.0.1:" + port + path).toURL().openConnection();
        http.setConnectTimeout(2000); http.setReadTimeout(4000); return http;
    }
    private static byte[] receive(DatagramSocket socket) throws IOException {
        byte[] bytes = new byte[20000]; DatagramPacket datagram = new DatagramPacket(bytes, bytes.length);
        socket.receive(datagram); return Arrays.copyOf(bytes, datagram.getLength());
    }
    private static Frame receiveFrame(DatagramSocket socket) throws IOException {
        byte[] bytes = receive(socket); return Frame.parse(bytes, bytes.length);
    }
    private static void transport() throws Exception {
        try (DatagramSocket relay = new DatagramSocket(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0));
             DatagramSocket sender = new DatagramSocket(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0))) {
            relay.setSoTimeout(3000);
            PpppConnection connection = new PpppConnection(sender, new InetSocketAddress("127.0.0.1", relay.getLocalPort()), null);
            MissClient camera = new MissClient(connection); byte[] key = new byte[32]; Arrays.fill(key, (byte) 17);
            camera.useSessionKey(key);
            Talkback talkback = new Talkback(camera, connection, key);
            AudioStreamServer.Format format = new AudioStreamServer.Format("PCMA", 16000, 1);
            try (AudioStreamServer server = new AudioStreamServer(format, talkback)) {
                server.start(); int port = server.port();
                check(port >= 1024);
                HttpURLConnection missing = request(port, "/missing"); check(missing.getResponseCode() == 404); missing.disconnect();
                try (Socket origin = new Socket("127.0.0.1", port)) {
                    origin.setSoTimeout(2000);
                    origin.getOutputStream().write(("GET /audio.wav HTTP/1.1\r\nHost: 127.0.0.1:" + port + "\r\nOrigin: http://example.test\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
                    check(new String(origin.getInputStream().readNBytes(12), StandardCharsets.US_ASCII).contains("403"));
                }
                try (Socket wrongHost = new Socket("127.0.0.1", port)) {
                    wrongHost.setSoTimeout(2000);
                    wrongHost.getOutputStream().write("GET /audio.wav HTTP/1.1\r\nHost: example.test\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
                    check(new String(wrongHost.getInputStream().readNBytes(12), StandardCharsets.US_ASCII).contains("403"));
                }
                HttpURLConnection listener = request(port, "/audio.wav"); check(listener.getResponseCode() == 200);
                InputStream audio = listener.getInputStream();
                check(Arrays.equals(audio.readNBytes(44), AudioCodecs.wavHeader(16000)));
                byte[] alaw = {(byte) 0xD5, (byte) 0x55, (byte) 0xAA};
                server.publish(new MediaPacket(1027, 0, 8, 0, alaw));
                check(Arrays.equals(audio.readNBytes(6), AudioCodecs.pcmFromAlaw(alaw)));
                HttpURLConnection[] extra = new HttpURLConnection[3];
                for (int i = 0; i < extra.length; i++) {
                    extra[i] = request(port, "/audio.wav"); check(extra[i].getResponseCode() == 200);
                    check(extra[i].getInputStream().readNBytes(44).length == 44);
                }
                HttpURLConnection full = request(port, "/audio.wav"); check(full.getResponseCode() == 503); full.disconnect();

                // A local talk POST must issue the real speaker start/data/stop sequence.
                HttpURLConnection post = request(port, "/talk.pcm"); post.setRequestMethod("POST"); post.setDoOutput(true);
                byte[] pcm = new byte[640];
                for (int i = 0; i < 320; i++) { pcm[i * 2] = (byte) i; pcm[i * 2 + 1] = (byte) (i >> 2); }
                post.setFixedLengthStreamingMode(pcm.length); post.getOutputStream().write(pcm); post.getOutputStream().close();
                check(post.getResponseCode() == 200);
                Frame start = receiveFrame(relay);
                check(start != null && start.type() == Msg.DRW && start.payload()[1] == 0);
                byte[] command = MissCrypto.decrypt(key, Arrays.copyOfRange(start.payload(), 12, start.payload().length));
                check(ByteBuffer.wrap(command).getInt() == 0x106);
                Frame media = receiveFrame(relay);
                check(media != null && media.type() == Msg.DRW && media.payload()[1] == 3);
                check(media.payload()[2] == 0 && media.payload()[3] == 0);
                byte[] message = Arrays.copyOfRange(media.payload(), 4, media.payload().length);
                check(ByteBuffer.wrap(message).getInt() == 360);
                ByteBuffer hdr = ByteBuffer.wrap(message).order(ByteOrder.LITTLE_ENDIAN);
                check(hdr.getInt(4) == 328 && hdr.getInt(8) == 1027);
                byte[] decoded = MissCrypto.decrypt(key, Arrays.copyOfRange(message, 36, message.length));
                check(decoded.length == 320);
                for (int i = 0; i < 320; i++) check(decoded[i] == AudioCodecs.encodeAlaw((short) ((pcm[i * 2] & 255) | (pcm[i * 2 + 1] << 8))));
                Frame stop = receiveFrame(relay);
                byte[] stopCommand = MissCrypto.decrypt(key, Arrays.copyOfRange(stop.payload(), 12, stop.payload().length));
                check(ByteBuffer.wrap(stopCommand).getInt() == 0x108);
                post.disconnect();
                // An empty POST cannot turn on the camera speaker.
                HttpURLConnection empty = request(port, "/talk.pcm"); empty.setRequestMethod("POST"); empty.setDoOutput(true);
                empty.setFixedLengthStreamingMode(0); empty.getOutputStream().close(); check(empty.getResponseCode() == 200); empty.disconnect();
                listener.disconnect(); for (HttpURLConnection item : extra) item.disconnect();

                // Large channel-3 payloads split into bounded UDP datagrams with independent sequence numbers.
                talkback.start(); check(receiveFrame(relay).payload()[1] == 0);
                byte[] opus = new byte[4000]; opus[0] = (byte) 0xFC;
                talkback.opus(opus);
                ByteArrayOutputStream fragments = new ByteArrayOutputStream();
                for (int i = 0; i < 4; i++) {
                    Frame fragment = receiveFrame(relay); byte[] part = fragment.payload();
                    check(part.length <= 1104 && part[1] == 3 && part[2] == 0 && (part[3] & 255) == i + 1);
                    fragments.write(part, 4, part.length - 4);
                }
                byte[] reassembled = fragments.toByteArray();
                check(ByteBuffer.wrap(reassembled).getInt() == 4040);
                check(Arrays.equals(MissCrypto.decrypt(key, Arrays.copyOfRange(reassembled, 36, reassembled.length)), opus));
                talkback.stop(); check(receiveFrame(relay).payload()[1] == 0);
            }
            connection.close();
        }
        System.out.println("ok");
    }
}
