package org.deepmarks.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.Arrays;
import java.util.List;

public class NostrEventSignerTest {
    private static final String SECRET_ONE =
        "0000000000000000000000000000000000000000000000000000000000000001";
    private static final String SECRET_ONE_PUBKEY =
        "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

    @Test
    public void canonicalEventMatchesNostrSerialization() {
        List<List<String>> tags = Arrays.asList(
            Arrays.asList("d", "https://example.com"),
            Arrays.asList("t", "nostr")
        );

        String canonical = NostrEventSigner.canonicalEvent(
            "1111111111111111111111111111111111111111111111111111111111111111",
            1700000000L,
            39701,
            tags,
            "hello\nworld"
        );

        assertEquals(
            "[0,\"1111111111111111111111111111111111111111111111111111111111111111\",1700000000,39701,[[\"d\",\"https://example.com\"],[\"t\",\"nostr\"]],\"hello\\nworld\"]",
            canonical
        );
    }

    @Test
    public void signEventUsesXOnlyPubkeyAndCanonicalId() throws Exception {
        List<List<String>> tags = Arrays.asList(
            Arrays.asList("d", "https://example.com"),
            Arrays.asList("t", "nostr")
        );

        NostrEventSigner.SignedEvent event = NostrEventSigner.signEvent(
            SECRET_ONE,
            39701,
            1700000000L,
            tags,
            "hello\nworld"
        );

        assertEquals(SECRET_ONE_PUBKEY, event.pubkey);
        assertEquals("0ddfe35d319fdbf5f5bd3a8de916f8678f733129629b1ab4817a1dafd434bfd2", event.id);
        assertEquals(128, event.sig.length());
        assertTrue(event.sig.matches("^[0-9a-f]{128}$"));
        assertTrue(NostrCrypto.schnorrVerify(NostrCrypto.bytesFromHex(event.id), event.pubkey, event.sig));
    }

    @Test
    public void jsonStringEscapesControlCharacters() {
        assertEquals("\"a\\nb\\\\c\\\"\\u0001\"", NostrEventSigner.jsonString("a\nb\\c\"\u0001"));
    }
}
