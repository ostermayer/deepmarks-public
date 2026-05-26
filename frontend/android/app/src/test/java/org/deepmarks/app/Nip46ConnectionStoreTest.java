package org.deepmarks.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;

import org.junit.Test;

import java.util.List;

public class Nip46ConnectionStoreTest {
    private static final String SIGNER_SECRET =
        "0000000000000000000000000000000000000000000000000000000000000001";
    private static final String SIGNER_PUBKEY =
        "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
    private static final String CLIENT_PUBKEY =
        "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";

    @Test
    public void parsesStoredAccount() {
        String raw = "{\"schemaVersion\":1,\"pubkey\":\"" + SIGNER_PUBKEY +
            "\",\"nsecHex\":\"" + SIGNER_SECRET + "\",\"createdAt\":1,\"updatedAt\":2}";

        NostrNip46RequestHandler.Account account = Nip46ConnectionStore.parseAccount(raw);

        assertNotNull(account);
        assertEquals(SIGNER_PUBKEY, account.pubkey);
        assertEquals(SIGNER_SECRET, account.nsecHex);
    }

    @Test
    public void parsesOnlyValidConnections() {
        String raw = "[" +
            "{\"id\":\"" + CLIENT_PUBKEY + "\",\"clientPubkey\":\"" + CLIENT_PUBKEY +
            "\",\"relays\":[\"wss://relay.deepmarks.org/\",\"ftp://bad\"],\"secret\":\"pair-secret\",\"perms\":[\"sign_event:1\"],\"createdAt\":1,\"lastSeenAt\":1}," +
            "{\"clientPubkey\":\"bad\",\"relays\":[\"wss://relay.deepmarks.org\"],\"secret\":\"pair-secret\",\"perms\":[]}" +
            "]";

        List<NostrNip46RequestHandler.Connection> connections = Nip46ConnectionStore.parseConnections(raw);

        assertEquals(1, connections.size());
        assertEquals(CLIENT_PUBKEY, connections.get(0).clientPubkey);
        assertEquals(1, connections.get(0).relays.size());
        assertEquals("wss://relay.deepmarks.org", connections.get(0).relays.get(0));
        assertEquals("sign_event:1", connections.get(0).perms.get(0));
    }
}
