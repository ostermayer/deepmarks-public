package org.deepmarks.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Color;
import android.graphics.Rect;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Parcelable;
import android.provider.OpenableColumns;
import android.text.Editable;
import android.text.InputType;
import android.text.Layout;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.widget.Button;
import android.widget.EditText;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.RadioButton;
import android.widget.RadioGroup;
import android.widget.ScrollView;
import android.widget.Switch;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class ShareActivity extends Activity {
    private static final Pattern HTTP_URL = Pattern.compile("https?://\\S+");
    private static final int BG = Color.rgb(242, 244, 247);
    private static final int CARD = Color.WHITE;
    private static final int TEXT = Color.rgb(20, 50, 73);
    private static final int MUTED = Color.rgb(108, 127, 148);
    private static final int SEPARATOR = Color.rgb(218, 228, 236);
    private static final int CORAL = Color.rgb(241, 111, 95);

    private final ExecutorService executor = Executors.newFixedThreadPool(3);

    private JSONObject pendingShare;
    private PendingShareStore.ShareDefaults defaults;
    private List<String> userTags = new ArrayList<>();
    private List<String> popularTags = new ArrayList<>();
    private List<String> suggestedTags = new ArrayList<>();

    private EditText urlInput;
    private EditText titleInput;
    private EditText descriptionInput;
    private EditText tagsInput;
    private Button autofillButton;
    private Button suggestedButton;
    private HorizontalScrollView autocompleteScroll;
    private LinearLayout autocompleteChips;
    private RadioButton publicRadio;
    private RadioButton privateRadio;
    private Switch readLaterSwitch;
    private Button saveButton;
    private Button cancelButton;
    private ProgressBar progress;
    private TextView statusText;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        configureSystemBars();
        getWindow().setSoftInputMode(
            WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE |
                WindowManager.LayoutParams.SOFT_INPUT_STATE_HIDDEN
        );
        handleShare(getIntent());
    }

    private void configureSystemBars() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            getWindow().setStatusBarColor(CARD);
            getWindow().setNavigationBarColor(BG);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
        }
    }

    @Override
    protected void onDestroy() {
        executor.shutdownNow();
        super.onDestroy();
    }

    /** Nostr clients share "nostr:nevent1…" or a bare note1/nevent1
     *  reference with no web URL. Wrap it as the canonical social URL
     *  the app bookmarks notes under (the JS save path normalizes the
     *  same forms). */
    private String extractNostrNoteUrl(String shared) {
        for (String raw : shared.split("\\s+")) {
            String token = raw.replaceAll("^[.,;:!?)\"\\]}']+|[.,;:!?)\"\\]}']+$", "");
            String lower = token.toLowerCase();
            if (lower.startsWith("nostr:")) lower = lower.substring(6);
            if ((lower.startsWith("note1") || lower.startsWith("nevent1"))
                    && lower.length() > 12
                    && lower.matches("[a-z0-9]+")) {
                return "https://primal.net/e/" + lower;
            }
        }
        return null;
    }

    private void handleShare(Intent intent) {
        try {
            defaults = PendingShareStore.readDefaults(this);
            userTags = PendingShareStore.readUserTags(this);
            String shared = collectSharedText(intent).trim();
            shared = shared.trim();
            String url = extractFirstHttpUrl(shared);
            if (url == null) {
                url = extractNostrNoteUrl(shared);
            }
            String title = extractTitle(intent, shared, url);
            if (url == null) {
                title = firstNonBlank(title, firstSharedDisplayName(intent));
                url = "";
            }
            pendingShare = PendingShareStore.buildShare(this, url, title, "");
            showEditor();
            if (!url.isEmpty()) {
                fetchMetadata();
                fetchPopularTags(url);
            }
        } catch (Exception e) {
            Toast.makeText(this, "Share failed", Toast.LENGTH_SHORT).show();
            finish();
        }
    }

    private void showEditor() {
        LinearLayout screen = new LinearLayout(this);
        screen.setOrientation(LinearLayout.VERTICAL);
        screen.setBackgroundColor(BG);

        screen.addView(topBar(), new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        ));

        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(false);
        screen.addView(
            scroll,
            new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                0,
                1
            )
        );

        LinearLayout stack = new LinearLayout(this);
        stack.setOrientation(LinearLayout.VERTICAL);
        stack.setPadding(dp(20), dp(12), dp(20), dp(24));
        scroll.addView(
            stack,
            new ScrollView.LayoutParams(
                ScrollView.LayoutParams.MATCH_PARENT,
                ScrollView.LayoutParams.WRAP_CONTENT
            )
        );

        urlInput = textField("https://...", pendingShare.optString("url", ""), 2);
        urlInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        urlInput.setImeOptions(EditorInfo.IME_ACTION_DONE);
        keepVisibleWhenEditing(scroll, urlInput);
        autofillButton = rowButton("AutoFill Metadata");
        autofillButton.setOnClickListener(v -> {
            fetchMetadata();
            fetchPopularTags(trimmed(urlInput));
        });
        stack.addView(section("URL", urlInput, autofillButton));

        titleInput = textField("Optional", pendingShare.optString("title", ""), 2);
        keepVisibleWhenEditing(scroll, titleInput);
        stack.addView(section("TITLE", titleInput));

        descriptionInput = textField("Optional", pendingShare.optString("description", ""), 3);
        descriptionInput.setInputType(
            InputType.TYPE_CLASS_TEXT |
                InputType.TYPE_TEXT_FLAG_MULTI_LINE |
                InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
        );
        keepVisibleWhenEditing(scroll, descriptionInput);
        stack.addView(section("DESCRIPTION", descriptionInput));

        tagsInput = textField(
            "Optional, space-separated. Prefix with a period for private tags.",
            initialTagsText(),
            2
        );
        tagsInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        keepVisibleWhenEditing(scroll, tagsInput);
        tagsInput.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int start, int count, int after) {}
            @Override public void onTextChanged(CharSequence s, int start, int before, int count) {
                updateAutocompleteSuggestions();
                keepFocusedInputVisible(scroll, tagsInput);
            }
            @Override public void afterTextChanged(Editable s) {}
        });
        autocompleteScroll = new HorizontalScrollView(this);
        autocompleteScroll.setHorizontalScrollBarEnabled(false);
        autocompleteChips = new LinearLayout(this);
        autocompleteChips.setOrientation(LinearLayout.HORIZONTAL);
        autocompleteScroll.addView(autocompleteChips);
        suggestedButton = rowButton("View Suggested Tags");
        suggestedButton.setOnClickListener(v -> showSuggestedTags());
        stack.addView(section("TAGS", tagsInput, autocompleteScroll, suggestedButton));
        updateAutocompleteSuggestions();

        readLaterSwitch = new Switch(this);
        readLaterSwitch.setChecked(defaults.defaultReadLater || containsDefaultTag("toread"));

        RadioGroup privacy = new RadioGroup(this);
        privacy.setOrientation(RadioGroup.HORIZONTAL);
        privacy.setGravity(Gravity.CENTER_VERTICAL);
        privateRadio = radio("Private");
        publicRadio = radio("Public");
        privacy.addView(privateRadio);
        privacy.addView(publicRadio);
        if ("public".equals(defaults.defaultVisibility)) publicRadio.setChecked(true);
        else privateRadio.setChecked(true);

        stack.addView(section("ADVANCED", labeledRow("Read Later", readLaterSwitch), labeledRow("Privacy", privacy)));

        progress = new ProgressBar(this);
        progress.setVisibility(View.GONE);
        LinearLayout.LayoutParams progressParams = new LinearLayout.LayoutParams(dp(34), dp(34));
        progressParams.setMargins(0, dp(6), 0, dp(6));
        stack.addView(progress, progressParams);

        statusText = new TextView(this);
        statusText.setTextColor(MUTED);
        statusText.setTextSize(13);
        statusText.setVisibility(View.GONE);
        stack.addView(statusText);

        setContentView(screen);
    }

    private View topBar() {
        LinearLayout wrap = new LinearLayout(this);
        wrap.setOrientation(LinearLayout.VERTICAL);
        wrap.setBackgroundColor(CARD);

        LinearLayout bar = new LinearLayout(this);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(dp(12), statusBarHeight() + dp(12), dp(12), dp(10));

        cancelButton = headerButton("Cancel", Gravity.START | Gravity.CENTER_VERTICAL);
        cancelButton.setOnClickListener(v -> finish());
        bar.addView(cancelButton, new LinearLayout.LayoutParams(dp(84), dp(44)));

        TextView title = new TextView(this);
        title.setText("Save Link");
        title.setTextColor(TEXT);
        title.setTextSize(17);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setGravity(Gravity.CENTER);
        title.setSingleLine(true);
        bar.addView(title, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1));

        saveButton = headerButton("Save", Gravity.END | Gravity.CENTER_VERTICAL);
        saveButton.setTypeface(Typeface.DEFAULT_BOLD);
        saveButton.setTextColor(CORAL);
        saveButton.setOnClickListener(v -> saveShare());
        bar.addView(saveButton, new LinearLayout.LayoutParams(dp(84), dp(44)));

        wrap.addView(bar);
        View divider = new View(this);
        divider.setBackgroundColor(SEPARATOR);
        wrap.addView(divider, new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            Math.max(1, dp(1))
        ));
        return wrap;
    }

    private Button headerButton(String text, int gravity) {
        Button button = new Button(this);
        button.setText(text);
        button.setAllCaps(false);
        button.setTextColor(TEXT);
        button.setTextSize(16);
        button.setGravity(gravity);
        button.setBackgroundColor(Color.TRANSPARENT);
        button.setMinWidth(0);
        button.setMinimumWidth(0);
        button.setMinHeight(0);
        button.setMinimumHeight(0);
        button.setPadding(dp(2), 0, dp(2), 0);
        return button;
    }

    private LinearLayout section(String title, View... rows) {
        LinearLayout outer = new LinearLayout(this);
        outer.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams outerParams = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        );
        outerParams.setMargins(0, 0, 0, dp(18));
        outer.setLayoutParams(outerParams);

        TextView label = new TextView(this);
        label.setText(title);
        label.setTextColor(MUTED);
        label.setTextSize(13);
        label.setPadding(0, 0, 0, dp(6));
        outer.addView(label);

        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setBackground(rounded(CARD, 14));
        card.setPadding(dp(18), dp(10), dp(18), dp(10));
        outer.addView(card, new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        ));

        for (int i = 0; i < rows.length; i++) {
            card.addView(rows[i]);
            if (i < rows.length - 1) {
                View separator = new View(this);
                separator.setBackgroundColor(SEPARATOR);
                LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    Math.max(1, dp(1))
                );
                params.setMargins(0, dp(6), 0, dp(6));
                card.addView(separator, params);
            }
        }
        return outer;
    }

    private EditText textField(String hint, String value, int minLines) {
        EditText input = new EditText(this);
        input.setText(value == null ? "" : value);
        input.setHint(hint);
        input.setTextColor(TEXT);
        input.setHintTextColor(MUTED);
        input.setTextSize(17);
        input.setMinLines(minLines);
        input.setSingleLine(false);
        input.setGravity(Gravity.TOP | Gravity.START);
        input.setPadding(0, dp(6), 0, dp(6));
        input.setBackgroundColor(Color.TRANSPARENT);
        input.setInputType(
            InputType.TYPE_CLASS_TEXT |
                InputType.TYPE_TEXT_FLAG_MULTI_LINE |
                InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
        );
        return input;
    }

    private Button rowButton(String text) {
        Button button = new Button(this);
        button.setText(text);
        button.setAllCaps(false);
        button.setTextColor(CORAL);
        button.setGravity(Gravity.START | Gravity.CENTER_VERTICAL);
        button.setBackgroundColor(Color.TRANSPARENT);
        button.setPadding(0, 0, 0, 0);
        return button;
    }

    private RadioButton radio(String text) {
        RadioButton radio = new RadioButton(this);
        radio.setId(View.generateViewId());
        radio.setText(text);
        radio.setTextColor(TEXT);
        radio.setTextSize(15);
        return radio;
    }

    private View labeledRow(String text, View control) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(0, dp(4), 0, dp(4));

        TextView label = new TextView(this);
        label.setText(text);
        label.setTextColor(TEXT);
        label.setTextSize(17);
        row.addView(label, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1));
        row.addView(control);
        return row;
    }

    private GradientDrawable rounded(int color, int radiusDp) {
        GradientDrawable shape = new GradientDrawable();
        shape.setColor(color);
        shape.setCornerRadius(dp(radiusDp));
        return shape;
    }

    private String initialTagsText() {
        List<String> out = new ArrayList<>();
        for (String tag : defaults.defaultTags.split("\\s+")) {
            if (!tag.isEmpty() && !"toread".equals(tag)) out.add(tag);
        }
        return String.join(" ", out);
    }

    private void saveShare() {
        try {
            applyInputsToShare();
            PendingShareStore.append(this, pendingShare);
        } catch (IllegalArgumentException e) {
            Toast.makeText(this, e.getMessage(), Toast.LENGTH_SHORT).show();
            return;
        } catch (Exception e) {
            Toast.makeText(this, "Could not save share", Toast.LENGTH_SHORT).show();
            return;
        }

        if (!NostrNativePublisher.canNativePublish(this, pendingShare)) {
            openHostApp(pendingShare);
            return;
        }

        setSaving(true, "Saving...");
        executor.execute(() -> {
            boolean published;
            try {
                NostrNativePublisher.publishBookmark(this, pendingShare);
                PendingShareStore.markPublished(this, pendingShare.optString("id"));
                published = true;
            } catch (Exception ignored) {
                published = false;
            }

            boolean ok = published;
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed()) return;
                if (ok) {
                    Toast.makeText(this, "Saved to Deepmarks", Toast.LENGTH_SHORT).show();
                    finish();
                } else {
                    openHostApp(pendingShare);
                }
            });
        });
    }

    private void applyInputsToShare() throws Exception {
        String url = trimmed(urlInput);
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            throw new IllegalArgumentException("Enter an http(s) URL to save");
        }
        pendingShare.put("url", url);
        pendingShare.put("title", truncate(trimmed(titleInput), 240));
        pendingShare.put("description", truncate(trimmed(descriptionInput), 2000));
        pendingShare.put("tags", normalizedTagsWithReadLater());
        pendingShare.put("readLater", readLaterValue());
        pendingShare.put("visibility", visibilityValue());
        pendingShare.put("autosave", "1");
    }

    private String readLaterValue() {
        if (readLaterSwitch.isChecked()) return "1";
        return (defaults.defaultReadLater || containsDefaultTag("toread")) ? "0" : "";
    }

    private String visibilityValue() {
        if (publicRadio.isChecked()) return "public";
        if (privateRadio.isChecked()) return "private";
        return "public".equals(defaults.defaultVisibility) ? "public" : "private";
    }

    private String normalizedTagsWithReadLater() {
        List<String> tags = normalizedTags();
        if (readLaterSwitch.isChecked() && !tags.contains("toread")) tags.add("toread");
        return String.join(" ", tags);
    }

    private List<String> normalizedTags() {
        List<String> tags = new ArrayList<>();
        Set<String> seen = new LinkedHashSet<>();
        for (String part : tagsInput.getText().toString().split("[\\s,]+")) {
            String tag = normalizeTag(part);
            if (tag.isEmpty() || seen.contains(tag)) continue;
            seen.add(tag);
            tags.add(tag);
            if (tags.size() >= 40) break;
        }
        return tags;
    }

    private void keepVisibleWhenEditing(ScrollView scroll, EditText input) {
        input.setOnClickListener(v -> scroll.postDelayed(() -> keepFocusedInputVisible(scroll, input), 80));
        input.setOnFocusChangeListener((v, hasFocus) -> {
            if (!hasFocus) return;
            scroll.postDelayed(() -> keepFocusedInputVisible(scroll, input), 80);
            scroll.postDelayed(() -> keepFocusedInputVisible(scroll, input), 280);
        });
    }

    private void keepFocusedInputVisible(ScrollView scroll, EditText input) {
        if (scroll == null || input == null || !input.hasFocus()) return;
        Rect target = caretRect(input);
        target.inset(0, -dp(96));
        scroll.requestChildRectangleOnScreen(input, target, false);
    }

    private Rect caretRect(EditText input) {
        Layout layout = input.getLayout();
        if (layout == null) {
            Rect fallback = new Rect();
            input.getDrawingRect(fallback);
            return fallback;
        }
        int offset = Math.max(0, input.getSelectionStart());
        int line = layout.getLineForOffset(offset);
        int top = layout.getLineTop(line) + input.getTotalPaddingTop() - input.getScrollY();
        int bottom = layout.getLineBottom(line) + input.getTotalPaddingTop() - input.getScrollY();
        return new Rect(0, top, input.getWidth(), bottom);
    }

    private void setSaving(boolean saving, String status) {
        urlInput.setEnabled(!saving);
        titleInput.setEnabled(!saving);
        descriptionInput.setEnabled(!saving);
        tagsInput.setEnabled(!saving);
        publicRadio.setEnabled(!saving);
        privateRadio.setEnabled(!saving);
        readLaterSwitch.setEnabled(!saving);
        saveButton.setEnabled(!saving);
        cancelButton.setEnabled(!saving);
        progress.setVisibility(saving ? View.VISIBLE : View.GONE);
        statusText.setText(status == null ? "" : status);
        statusText.setVisibility(saving ? View.VISIBLE : View.GONE);
    }

    private void fetchMetadata() {
        String raw = trimmed(urlInput);
        if (!raw.startsWith("http://") && !raw.startsWith("https://")) return;
        autofillButton.setText("Loading Metadata...");
        executor.execute(() -> {
            String title = "";
            String description = "";
            List<String> tags = new ArrayList<>();
            try {
                // enrich=0 — skip the server's inline LLM round-trip so the
                // share sheet autofills as fast as possible. The saved
                // bookmark still gets LLM-enriched by the backend backfill
                // after it publishes.
                JSONObject json = getJson("https://api.deepmarks.org/metadata?url=" + encode(raw) + "&enrich=0");
                title = json.optString("title", "");
                description = json.optString("description", "");
                JSONArray arr = json.optJSONArray("suggestedTags");
                if (arr != null) {
                    for (int i = 0; i < arr.length(); i++) {
                        String tag = normalizeTag(arr.optString(i, ""));
                        if (!tag.isEmpty()) tags.add(tag);
                    }
                }
            } catch (Exception ignored) {
                // Non-blocking: the user can still edit fields manually.
            }
            String finalTitle = title;
            String finalDescription = description;
            List<String> finalTags = tags;
            runOnUiThread(() -> {
                if (!canUpdateEditor()) return;
                autofillButton.setText("AutoFill Metadata");
                if (trimmed(titleInput).isEmpty() && !finalTitle.isEmpty()) {
                    titleInput.setText(finalTitle);
                }
                if (trimmed(descriptionInput).isEmpty() && !finalDescription.isEmpty()) {
                    descriptionInput.setText(finalDescription);
                }
                suggestedTags = finalTags;
                suggestedButton.setText(
                    finalTags.isEmpty() ? "View Suggested Tags" : "View Suggested Tags (" + finalTags.size() + ")"
                );
            });
        });
    }

    private void fetchPopularTags(String raw) {
        if (raw == null || (!raw.startsWith("http://") && !raw.startsWith("https://"))) return;
        executor.execute(() -> {
            List<String> tags = new ArrayList<>();
            try {
                JSONObject json = getJson("https://api.deepmarks.org/tags/popular?url=" + encode(raw));
                JSONArray arr = json.optJSONArray("tags");
                if (arr != null) {
                    for (int i = 0; i < arr.length(); i++) {
                        String tag = normalizeTag(arr.optString(i, ""));
                        if (!tag.isEmpty()) tags.add(tag);
                    }
                }
            } catch (Exception ignored) {
                // Suggestions are optional.
            }
            List<String> finalTags = tags;
            runOnUiThread(() -> {
                if (!canUpdateEditor()) return;
                popularTags = finalTags;
                updateAutocompleteSuggestions();
            });
        });
    }

    private JSONObject getJson(String url) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        try {
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(12_000);
            conn.setReadTimeout(12_000);
            conn.setRequestProperty("User-Agent", "Deepmarks Android Share");
            int status = conn.getResponseCode();
            InputStream input = status >= 200 && status < 300 ? conn.getInputStream() : conn.getErrorStream();
            String body = readAll(input);
            if (status < 200 || status >= 300) throw new IllegalStateException("request " + status);
            return new JSONObject(body);
        } finally {
            conn.disconnect();
        }
    }

    private boolean canUpdateEditor() {
        return !isFinishing() && !isDestroyed() && saveButton != null && saveButton.isEnabled();
    }

    private void showSuggestedTags() {
        if (suggestedTags.isEmpty()) {
            new AlertDialog.Builder(this)
                .setTitle("Suggested Tags")
                .setMessage("No suggested tags yet. Tap AutoFill Metadata first.")
                .setPositiveButton("OK", null)
                .show();
            return;
        }
        String[] items = suggestedTags.toArray(new String[0]);
        new AlertDialog.Builder(this)
            .setTitle("Suggested Tags")
            .setItems(items, (dialog, which) -> appendTag(items[which]))
            .setNegativeButton("Cancel", null)
            .show();
    }

    private void updateAutocompleteSuggestions() {
        if (autocompleteChips == null) return;
        autocompleteChips.removeAllViews();
        String prefix = currentTagPrefix();
        Set<String> existing = new LinkedHashSet<>(normalizedTags());
        List<String> picked = new ArrayList<>();
        Set<String> seen = new LinkedHashSet<>();
        addSuggestionsFrom(userTags, prefix, existing, seen, picked);
        addSuggestionsFrom(popularTags, prefix, existing, seen, picked);
        if (picked.isEmpty()) {
            autocompleteScroll.setVisibility(View.GONE);
            return;
        }
        autocompleteScroll.setVisibility(View.VISIBLE);
        for (String tag : picked) {
            Button chip = new Button(this);
            chip.setText(tag);
            chip.setAllCaps(false);
            chip.setTextColor(TEXT);
            chip.setTextSize(14);
            chip.setPadding(dp(10), 0, dp(10), 0);
            chip.setOnClickListener(v -> completeTag(tag));
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                dp(32)
            );
            params.setMargins(0, 0, dp(6), 0);
            autocompleteChips.addView(chip, params);
        }
    }

    private void addSuggestionsFrom(
        List<String> source,
        String prefix,
        Set<String> existing,
        Set<String> seen,
        List<String> picked
    ) {
        for (String raw : source) {
            String tag = normalizeTag(raw);
            if (tag.isEmpty() || existing.contains(tag) || seen.contains(tag)) continue;
            if (!prefix.isEmpty() && !tag.startsWith(prefix)) continue;
            seen.add(tag);
            picked.add(tag);
            if (picked.size() >= 12) return;
        }
    }

    private String currentTagPrefix() {
        String raw = tagsInput == null ? "" : tagsInput.getText().toString();
        if (raw.isEmpty()) return "";
        char last = raw.charAt(raw.length() - 1);
        if (Character.isWhitespace(last) || last == ',') return "";
        String[] parts = raw.split("[\\s,]+");
        return parts.length == 0 ? "" : normalizeTag(parts[parts.length - 1]);
    }

    private void completeTag(String tag) {
        String raw = tagsInput.getText().toString();
        String replaced = raw;
        if (!raw.isEmpty()) {
            char last = raw.charAt(raw.length() - 1);
            if (!Character.isWhitespace(last) && last != ',') {
                int cut = Math.max(raw.lastIndexOf(' '), raw.lastIndexOf(','));
                replaced = cut >= 0 ? raw.substring(0, cut + 1) + tag : tag;
            } else {
                replaced = raw + tag;
            }
        } else {
            replaced = tag;
        }
        if (!replaced.endsWith(" ")) replaced += " ";
        tagsInput.setText(replaced);
        tagsInput.setSelection(tagsInput.getText().length());
        updateAutocompleteSuggestions();
    }

    private void appendTag(String tag) {
        String normalized = normalizeTag(tag);
        if (normalized.isEmpty()) return;
        List<String> tags = normalizedTags();
        if (!tags.contains(normalized)) tags.add(normalized);
        tagsInput.setText(String.join(" ", tags) + " ");
        tagsInput.setSelection(tagsInput.getText().length());
        updateAutocompleteSuggestions();
    }

    private void openHostApp(JSONObject pendingShare) {
        Uri appUri = new Uri.Builder()
            .scheme("deepmarks")
            .authority("save")
            .appendQueryParameter("pendingShareId", pendingShare.optString("id"))
            .appendQueryParameter("url", pendingShare.optString("url"))
            .appendQueryParameter("title", pendingShare.optString("title"))
            .appendQueryParameter("description", pendingShare.optString("description"))
            .appendQueryParameter("tags", pendingShare.optString("tags"))
            .appendQueryParameter("readLater", pendingShare.optString("readLater"))
            .appendQueryParameter("autosave", "1")
            .appendQueryParameter("visibility", pendingShare.optString("visibility"))
            .build();
        Intent forwarded = new Intent(Intent.ACTION_VIEW, appUri);
        forwarded.setPackage(getPackageName());
        forwarded.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            startActivity(forwarded);
        } catch (Exception ignored) {
            Toast.makeText(this, "Open Deepmarks to finish saving", Toast.LENGTH_SHORT).show();
        }
        finish();
    }

    private static String extractFirstHttpUrl(String text) {
        Matcher matcher = HTTP_URL.matcher(text);
        if (matcher.find()) return trimSharedUrl(matcher.group());
        return null;
    }

    private static String extractTitle(Intent intent, String shared, String url) {
        String explicit = firstNonBlank(
            intent == null ? null : intent.getStringExtra(Intent.EXTRA_TITLE),
            intent == null ? null : intent.getStringExtra(Intent.EXTRA_SUBJECT)
        );
        if (explicit != null) return explicit;

        String withoutUrl = url == null || url.isEmpty() ? shared.trim() : shared.replace(url, "").trim();
        if (withoutUrl.isEmpty()) return "";
        for (String line : withoutUrl.split("\\R")) {
            String title = line.trim();
            if (!title.isEmpty() && !title.startsWith("http://") && !title.startsWith("https://")) {
                return truncate(title, 240);
            }
        }
        return "";
    }

    private String collectSharedText(Intent intent) {
        if (intent == null) return "";
        StringBuilder out = new StringBuilder();
        append(out, intent.getCharSequenceExtra(Intent.EXTRA_TEXT));
        append(out, intent.getStringExtra(Intent.EXTRA_HTML_TEXT));
        append(out, intent.getDataString());
        ClipData clipData = intent.getClipData();
        if (clipData != null) {
            for (int i = 0; i < clipData.getItemCount(); i++) {
                ClipData.Item item = clipData.getItemAt(i);
                append(out, item.getText());
                append(out, item.getHtmlText());
                Uri uri = item.getUri();
                if (uri != null) append(out, uri.toString());
                Intent nested = item.getIntent();
                if (nested != null) append(out, collectSharedText(nested));
            }
        }
        Uri stream = firstSharedUri(intent);
        if (stream != null) append(out, stream.toString());
        return out.toString();
    }

    private static void append(StringBuilder out, CharSequence value) {
        if (value == null) return;
        String text = value.toString().trim();
        if (text.isEmpty()) return;
        if (out.length() > 0) out.append('\n');
        out.append(text);
    }

    private Uri firstSharedUri(Intent intent) {
        if (intent == null) return null;
        Parcelable stream = intent.getParcelableExtra(Intent.EXTRA_STREAM);
        if (stream instanceof Uri) return (Uri) stream;
        ArrayList<Uri> streams = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
        if (streams != null && !streams.isEmpty()) return streams.get(0);
        ClipData clipData = intent.getClipData();
        if (clipData != null) {
            for (int i = 0; i < clipData.getItemCount(); i++) {
                Uri uri = clipData.getItemAt(i).getUri();
                if (uri != null) return uri;
            }
        }
        return null;
    }

    private String firstSharedDisplayName(Intent intent) {
        Uri uri = firstSharedUri(intent);
        if (uri == null) return "";
        if ("content".equals(uri.getScheme())) {
            try (Cursor cursor = getContentResolver().query(uri, null, null, null, null)) {
                if (cursor != null && cursor.moveToFirst()) {
                    int index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                    if (index >= 0) {
                        String displayName = cursor.getString(index);
                        if (displayName != null && !displayName.trim().isEmpty()) return displayName.trim();
                    }
                }
            } catch (Exception ignored) {
                // Display name is only a convenience for file-only shares.
            }
        }
        String last = uri.getLastPathSegment();
        return last == null ? "" : last;
    }

    private static String firstNonBlank(String a, String b) {
        if (a != null && !a.trim().isEmpty()) return a.trim();
        if (b != null && !b.trim().isEmpty()) return b.trim();
        return null;
    }

    private static String trimSharedUrl(String value) {
        String out = value.trim();
        while (
            out.endsWith(".") ||
            out.endsWith(",") ||
            out.endsWith(";") ||
            out.endsWith(":") ||
            out.endsWith("!") ||
            out.endsWith("?") ||
            out.endsWith(")") ||
            out.endsWith("]") ||
            out.endsWith("\"") ||
            out.endsWith("'")
        ) {
            out = out.substring(0, out.length() - 1);
        }
        return out;
    }

    private static String normalizeTag(String raw) {
        String tag = raw == null ? "" : raw.trim()
            .replaceFirst("^#+", "")
            .toLowerCase(Locale.ROOT);
        return tag.isEmpty() || tag.length() > 48 ? "" : tag;
    }

    private static String truncate(String value, int max) {
        if (value == null) return "";
        return value.length() <= max ? value : value.substring(0, max);
    }

    private static String readAll(InputStream input) {
        if (input == null) return "";
        try (InputStream in = input; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[1024];
            int n;
            while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
            return out.toString(StandardCharsets.UTF_8.name());
        } catch (Exception ignored) {
            return "";
        }
    }

    private static String encode(String raw) throws Exception {
        return URLEncoder.encode(raw, StandardCharsets.UTF_8.name());
    }

    private boolean containsDefaultTag(String tag) {
        for (String part : defaults.defaultTags.split("\\s+")) {
            if (tag.equals(part)) return true;
        }
        return false;
    }

    private String trimmed(EditText input) {
        return input == null ? "" : input.getText().toString().trim();
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private int statusBarHeight() {
        int id = getResources().getIdentifier("status_bar_height", "dimen", "android");
        return id > 0 ? getResources().getDimensionPixelSize(id) : 0;
    }
}
