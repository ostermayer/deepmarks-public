package org.deepmarks.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import org.junit.Test;

public class NostrNip44Test {
    private static final String SECRET_ONE =
        "0000000000000000000000000000000000000000000000000000000000000001";
    private static final String SECRET_TWO =
        "0000000000000000000000000000000000000000000000000000000000000002";
    private static final String PUB_ONE =
        "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
    private static final String PUB_TWO =
        "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
    private static final String NONCE =
        "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
    private static final String PLAINTEXT =
        "{\"id\":\"req-1\",\"method\":\"ping\",\"params\":[]}";
    private static final String CONVERSATION_KEY =
        "c41c775356fd92eadc63ff5a0dc1da211b268cbea22316767095b2871ea1412d";
    private static final String PAYLOAD =
        "AgABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4fWT+pS5GgqgtAksJgZhUJm+AoG6ZYk38iPwCIo/KDbkaDWdVtTsXMpGPLlr/j0DpV7MZMsqVxqfOJs89gHzu3pRtERbKqtCVruI9MI3BGLAw54izz9gDGcBD3MaWo5S62Qk8=";

    @Test
    public void derivesSymmetricConversationKey() throws Exception {
        byte[] fromOne = NostrNip44.conversationKey(SECRET_ONE, PUB_TWO);
        byte[] fromTwo = NostrNip44.conversationKey(SECRET_TWO, PUB_ONE);

        assertEquals(CONVERSATION_KEY, NostrCrypto.hex(fromOne));
        assertEquals(CONVERSATION_KEY, NostrCrypto.hex(fromTwo));
    }

    @Test
    public void encryptsAndDecryptsNip46EnvelopeLikeNostrTools() throws Exception {
        byte[] conversationKey = NostrNip44.conversationKey(SECRET_ONE, PUB_TWO);
        String payload = NostrNip44.encrypt(PLAINTEXT, conversationKey, NostrCrypto.bytesFromHex(NONCE));

        assertEquals(PAYLOAD, payload);
        assertEquals(PLAINTEXT, NostrNip44.decrypt(payload, NostrNip44.conversationKey(SECRET_TWO, PUB_ONE)));
    }

    @Test
    public void rejectsPayloadWithBadMac() throws Exception {
        byte[] conversationKey = NostrNip44.conversationKey(SECRET_ONE, PUB_TWO);
        char[] bad = PAYLOAD.toCharArray();
        bad[20] = bad[20] == 'A' ? 'B' : 'A';

        assertThrows(
            IllegalArgumentException.class,
            () -> NostrNip44.decrypt(new String(bad), conversationKey)
        );
    }

    @Test
    public void matchesNip44PaddingBuckets() {
        assertEquals(32, NostrNip44.calcPaddedLen(1));
        assertEquals(32, NostrNip44.calcPaddedLen(32));
        assertEquals(64, NostrNip44.calcPaddedLen(33));
        assertEquals(64, NostrNip44.calcPaddedLen(64));
        assertEquals(96, NostrNip44.calcPaddedLen(65));
        assertEquals(256, NostrNip44.calcPaddedLen(256));
        assertEquals(320, NostrNip44.calcPaddedLen(257));
        assertEquals(65_536, NostrNip44.calcPaddedLen(65_535));
    }
}
