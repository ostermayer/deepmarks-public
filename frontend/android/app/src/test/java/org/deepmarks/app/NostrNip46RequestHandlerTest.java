package org.deepmarks.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Map;

public class NostrNip46RequestHandlerTest {
    private static final String SIGNER_SECRET =
        "0000000000000000000000000000000000000000000000000000000000000001";
    private static final String CLIENT_SECRET =
        "0000000000000000000000000000000000000000000000000000000000000002";
    private static final String SIGNER_PUBKEY =
        "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
    private static final String CLIENT_PUBKEY =
        "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
    private static final List<String> RELAYS = Collections.singletonList("wss://relay.deepmarks.org");

    @Test
    public void handlesPingRequestOffline() throws Exception {
        NostrNip46RequestHandler.Account account = new NostrNip46RequestHandler.Account(SIGNER_SECRET);
        NostrNip46RequestHandler.Connection connection = connection(Collections.emptyList());
        String requestEvent = requestEvent("{\"id\":\"req-1\",\"method\":\"ping\",\"params\":[]}");

        NostrEventSigner.SignedEvent response = NostrNip46RequestHandler.handle(
            account,
            connection,
            requestEvent,
            1_700_000_500L
        );

        assertNotNull(response);
        assertEquals(NostrNip46RequestHandler.KIND, response.kind);
        assertEquals(SIGNER_PUBKEY, response.pubkey);
        assertTrue(NostrNip46RequestHandler.IncomingEvent.parse(response.toJson()).verify());
        Map<String, Object> payload = decryptResponse(response);
        assertEquals("req-1", payload.get("id"));
        assertEquals("pong", payload.get("result"));
    }

    @Test
    public void signsAllowedEventTemplate() throws Exception {
        NostrNip46RequestHandler.Account account = new NostrNip46RequestHandler.Account(SIGNER_SECRET);
        NostrNip46RequestHandler.Connection connection = connection(Collections.singletonList("sign_event:1"));
        String template = "{\"kind\":1,\"created_at\":1700000100,\"tags\":[[\"t\",\"deepmarks\"]],\"content\":\"hello\"}";
        String request = "{\"id\":\"req-2\",\"method\":\"sign_event\",\"params\":[" + NostrJson.quote(template) + "]}";

        NostrEventSigner.SignedEvent response = NostrNip46RequestHandler.handle(
            account,
            connection,
            requestEvent(request),
            1_700_000_501L
        );

        Map<String, Object> payload = decryptResponse(response);
        Map<String, Object> signed = NostrJson.parseObject((String) payload.get("result"));
        assertEquals("req-2", payload.get("id"));
        assertEquals(1L, signed.get("kind"));
        assertEquals("hello", signed.get("content"));
        assertEquals(SIGNER_PUBKEY, signed.get("pubkey"));
        assertTrue(NostrNip46RequestHandler.IncomingEvent.parse((String) payload.get("result")).verify());
    }

    @Test
    public void returnsEncryptedErrorForUnauthorizedSignEvent() throws Exception {
        NostrNip46RequestHandler.Account account = new NostrNip46RequestHandler.Account(SIGNER_SECRET);
        NostrNip46RequestHandler.Connection connection = connection(Collections.singletonList("sign_event:0"));
        String template = "{\"kind\":1,\"created_at\":1700000100,\"tags\":[],\"content\":\"hello\"}";
        String request = "{\"id\":\"req-3\",\"method\":\"sign_event\",\"params\":[" + NostrJson.quote(template) + "]}";

        NostrEventSigner.SignedEvent response = NostrNip46RequestHandler.handle(
            account,
            connection,
            requestEvent(request),
            1_700_000_502L
        );

        Map<String, Object> payload = decryptResponse(response);
        assertEquals("req-3", payload.get("id"));
        assertEquals("error", payload.get("result"));
        assertEquals("not authorized: sign_event", payload.get("error"));
    }

    @Test
    public void extractsPermissionsRequestedByConnect() throws Exception {
        NostrNip46RequestHandler.Account account = new NostrNip46RequestHandler.Account(SIGNER_SECRET);
        NostrNip46RequestHandler.Connection connection = connection(Collections.emptyList());
        String request = "{\"id\":\"req-connect\",\"method\":\"connect\",\"params\":[" +
            NostrJson.quote(SIGNER_PUBKEY) + "," +
            NostrJson.quote("pair-secret") + "," +
            NostrJson.quote("sign_event:1,nip44_encrypt") + "]}";

        List<String> permissions = NostrNip46RequestHandler.connectRequestedPermissions(
            account,
            connection,
            requestEvent(request)
        );

        assertEquals(Arrays.asList("sign_event:1", "nip44_encrypt"), permissions);
    }

    @Test
    public void fullTrustAllowsAnySignEvent() throws Exception {
        NostrNip46RequestHandler.Account account = new NostrNip46RequestHandler.Account(SIGNER_SECRET);
        NostrNip46RequestHandler.Connection connection = new NostrNip46RequestHandler.Connection(
            CLIENT_PUBKEY,
            RELAYS,
            Collections.emptyList(),
            "Amethyst",
            "",
            "",
            NostrNip46RequestHandler.Connection.TRUST_FULL
        );
        String template = "{\"kind\":1,\"created_at\":1700000100,\"tags\":[],\"content\":\"hello\"}";
        String request = "{\"id\":\"req-full\",\"method\":\"sign_event\",\"params\":[" + NostrJson.quote(template) + "]}";

        Map<String, Object> payload = decryptResponse(NostrNip46RequestHandler.handle(
            account,
            connection,
            requestEvent(request),
            1_700_000_502L
        ));

        assertEquals("req-full", payload.get("id"));
        assertTrue(payload.get("result") instanceof String);
    }

    @Test
    public void handlesEncryptionMethodsWhenPermitted() throws Exception {
        NostrNip46RequestHandler.Account account = new NostrNip46RequestHandler.Account(SIGNER_SECRET);
        NostrNip46RequestHandler.Connection connection = connection(Arrays.asList(
            "nip04_encrypt",
            "nip04_decrypt",
            "nip44_encrypt",
            "nip44_decrypt"
        ));

        Map<String, Object> nip44Encrypted = decryptResponse(NostrNip46RequestHandler.handle(
            account,
            connection,
            requestEvent("{\"id\":\"req-n44e\",\"method\":\"nip44_encrypt\",\"params\":[" +
                NostrJson.quote(CLIENT_PUBKEY) + "," + NostrJson.quote("hello nip44") + "]}"),
            1_700_000_505L
        ));
        String nip44Payload = (String) nip44Encrypted.get("result");
        assertEquals(
            "hello nip44",
            NostrNip44.decrypt(nip44Payload, NostrNip44.conversationKey(CLIENT_SECRET, SIGNER_PUBKEY))
        );

        String clientNip44Payload = NostrNip44.encrypt(
            "decrypt me",
            NostrNip44.conversationKey(CLIENT_SECRET, SIGNER_PUBKEY),
            NostrCrypto.bytesFromHex("303132333435363738393a3b3c3d3e3f404142434445464748494a4b4c4d4e4f")
        );
        Map<String, Object> nip44Decrypted = decryptResponse(NostrNip46RequestHandler.handle(
            account,
            connection,
            requestEvent("{\"id\":\"req-n44d\",\"method\":\"nip44_decrypt\",\"params\":[" +
                NostrJson.quote(CLIENT_PUBKEY) + "," + NostrJson.quote(clientNip44Payload) + "]}"),
            1_700_000_506L
        ));
        assertEquals("decrypt me", nip44Decrypted.get("result"));

        Map<String, Object> nip04Encrypted = decryptResponse(NostrNip46RequestHandler.handle(
            account,
            connection,
            requestEvent("{\"id\":\"req-n04e\",\"method\":\"nip04_encrypt\",\"params\":[" +
                NostrJson.quote(CLIENT_PUBKEY) + "," + NostrJson.quote("hello nip04") + "]}"),
            1_700_000_507L
        ));
        assertEquals(
            "hello nip04",
            NostrNip04.decrypt(CLIENT_SECRET, SIGNER_PUBKEY, (String) nip04Encrypted.get("result"))
        );

        String clientNip04Payload = NostrNip04.encrypt(CLIENT_SECRET, SIGNER_PUBKEY, "nip04 decrypt me");
        Map<String, Object> nip04Decrypted = decryptResponse(NostrNip46RequestHandler.handle(
            account,
            connection,
            requestEvent("{\"id\":\"req-n04d\",\"method\":\"nip04_decrypt\",\"params\":[" +
                NostrJson.quote(CLIENT_PUBKEY) + "," + NostrJson.quote(clientNip04Payload) + "]}"),
            1_700_000_508L
        ));
        assertEquals("nip04 decrypt me", nip04Decrypted.get("result"));
    }

    @Test
    public void ignoresBadEventSignatureBeforeDecrypting() throws Exception {
        NostrNip46RequestHandler.Account account = new NostrNip46RequestHandler.Account(SIGNER_SECRET);
        NostrNip46RequestHandler.Connection connection = connection(Collections.emptyList());
        Map<String, Object> tampered = NostrJson.parseObject(requestEvent("{\"id\":\"req-4\",\"method\":\"ping\",\"params\":[]}"));
        tampered.put("content", ((String) tampered.get("content")) + "a");

        assertNull(NostrNip46RequestHandler.handle(
            account,
            connection,
            NostrJson.stringify(tampered),
            1_700_000_503L
        ));
    }

    @Test
    public void ignoresMalformedRelayEvents() throws Exception {
        NostrNip46RequestHandler.Account account = new NostrNip46RequestHandler.Account(SIGNER_SECRET);
        NostrNip46RequestHandler.Connection connection = connection(Collections.emptyList());

        assertNull(NostrNip46RequestHandler.handle(
            account,
            connection,
            "{\"not an event\"",
            1_700_000_504L
        ));
    }

    private static NostrNip46RequestHandler.Connection connection(List<String> perms) {
        return new NostrNip46RequestHandler.Connection(CLIENT_PUBKEY, RELAYS, perms);
    }

    private static String requestEvent(String requestJson) throws Exception {
        byte[] conversationKey = NostrNip44.conversationKey(CLIENT_SECRET, SIGNER_PUBKEY);
        String content = NostrNip44.encrypt(
            requestJson,
            conversationKey,
            NostrCrypto.bytesFromHex("202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f")
        );
        NostrEventSigner.SignedEvent event = NostrEventSigner.signEvent(
            CLIENT_SECRET,
            NostrNip46RequestHandler.KIND,
            1_700_000_000L,
            Arrays.asList(Arrays.asList("p", SIGNER_PUBKEY)),
            content
        );
        return event.toJson();
    }

    private static Map<String, Object> decryptResponse(NostrEventSigner.SignedEvent response) throws Exception {
        assertNotNull(response);
        byte[] conversationKey = NostrNip44.conversationKey(CLIENT_SECRET, SIGNER_PUBKEY);
        return NostrJson.parseObject(NostrNip44.decrypt(response.content, conversationKey));
    }
}
