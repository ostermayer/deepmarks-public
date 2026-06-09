import UIKit
import UniformTypeIdentifiers

private final class PlaceholderTextView: UITextView {
    private let placeholderLabel = UILabel()

    var placeholder: String = "" {
        didSet { placeholderLabel.text = placeholder }
    }

    override var text: String! {
        didSet { updatePlaceholder() }
    }

    override var font: UIFont? {
        didSet { placeholderLabel.font = font }
    }

    override init(frame: CGRect, textContainer: NSTextContainer?) {
        super.init(frame: frame, textContainer: textContainer)
        commonInit()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        commonInit()
    }

    private func commonInit() {
        placeholderLabel.textColor = .placeholderText
        placeholderLabel.numberOfLines = 0
        placeholderLabel.translatesAutoresizingMaskIntoConstraints = false
        addSubview(placeholderLabel)
        NSLayoutConstraint.activate([
            placeholderLabel.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 0),
            placeholderLabel.trailingAnchor.constraint(equalTo: trailingAnchor, constant: 0),
            placeholderLabel.topAnchor.constraint(equalTo: topAnchor, constant: 8)
        ])
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(textDidChange),
            name: UITextView.textDidChangeNotification,
            object: self
        )
        updatePlaceholder()
    }

    @objc private func textDidChange() {
        updatePlaceholder()
    }

    private func updatePlaceholder() {
        placeholderLabel.isHidden = !text.isEmpty
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }
}

class ShareViewController: UIViewController, UITextViewDelegate {
    private let appGroupIdentifier = "group.org.deepmarks.app.shared"
    private let pendingSharesKey = "deepmarks-pending-shares-v1"
    private let userTagsKey = "deepmarks-user-tags-v1"
    private let shareDefaultsKey = "deepmarks-share-defaults-v1"
    private let scrollView = UIScrollView()
    private let stack = UIStackView()
    private let urlView = PlaceholderTextView()
    private let titleView = PlaceholderTextView()
    private let descriptionView = PlaceholderTextView()
    private let tagsView = PlaceholderTextView()
    private let autofillButton = UIButton(type: .system)
    private let suggestedButton = UIButton(type: .system)
    private let saveButton = UIButton(type: .system)
    private let readLaterSwitch = UISwitch()
    private let privacyControl = UISegmentedControl(items: ["Private", "Public"])
    /** Page-derived suggestions (meta keywords / og:article:tag), shown in the modal sheet. */
    private var suggestedTags: [String] = []
    /** User's own tags from AppGroup — written by the main app whenever own-bookmarks updates. */
    private var userTags: [String] = []
    private var defaultVisibility = "private"
    private var defaultReadLater = false
    private var defaultTags: [String] = []
    private var activePubkey = ""
    /** Popular tags others have applied to this URL, fetched from /tags/popular. */
    private var popularTags: [String] = []
    private let autoCompleteScroll = UIScrollView()
    private let autoCompleteStack = UIStackView()
    private var autoCompleteHeightConstraint: NSLayoutConstraint?
    private var keyboardObservers: [NSObjectProtocol] = []

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor.systemGroupedBackground
        loadUserTags()
        loadShareDefaults()
        configureTopBar()
        configureForm()
        observeKeyboard()
        extractSharedURL { [weak self] url in
            DispatchQueue.main.async {
                guard let self = self else { return }
                if let url {
                    self.urlView.text = url.absoluteString
                    self.fetchMetadata()
                    self.fetchPopularTags(for: url.absoluteString)
                }
            }
        }
    }

    private func loadUserTags() {
        guard let defaults = UserDefaults(suiteName: appGroupIdentifier) else { return }
        if let stored = defaults.array(forKey: userTagsKey) as? [String] {
            userTags = stored
        }
    }

    private func loadShareDefaults() {
        guard let defaults = UserDefaults(suiteName: appGroupIdentifier) else { return }
        defaults.synchronize()
        guard let stored = defaults.dictionary(forKey: shareDefaultsKey) else { return }
        if let visibility = stored["defaultVisibility"] as? String {
            defaultVisibility = visibility == "public" ? "public" : "private"
        }
        if let readLater = stored["defaultReadLater"] as? Bool {
            defaultReadLater = readLater
        }
        if let tags = stored["defaultTags"] as? [String] {
            defaultTags = tags
                .map { normalizeTag($0) }
                .filter { !$0.isEmpty }
        }
        if let pubkey = stored["activePubkey"] as? String {
            activePubkey = normalizePubkey(pubkey)
        }
    }

    private func configureTopBar() {
        let bar = UIView()
        bar.translatesAutoresizingMaskIntoConstraints = false
        bar.backgroundColor = .systemBackground
        view.addSubview(bar)

        let cancelButton = UIButton(type: .system)
        cancelButton.setTitle("Cancel", for: .normal)
        cancelButton.titleLabel?.font = .systemFont(ofSize: 17)
        cancelButton.addTarget(self, action: #selector(cancel), for: .touchUpInside)

        let titleLabel = UILabel()
        titleLabel.text = "Save Link"
        titleLabel.font = .boldSystemFont(ofSize: 17)
        titleLabel.textAlignment = .center

        saveButton.setTitle("Save", for: .normal)
        saveButton.titleLabel?.font = .boldSystemFont(ofSize: 17)
        saveButton.addTarget(self, action: #selector(save), for: .touchUpInside)

        [cancelButton, titleLabel, saveButton].forEach {
            $0.translatesAutoresizingMaskIntoConstraints = false
            bar.addSubview($0)
        }

        let divider = UIView()
        divider.backgroundColor = .separator
        divider.translatesAutoresizingMaskIntoConstraints = false
        bar.addSubview(divider)

        NSLayoutConstraint.activate([
            bar.topAnchor.constraint(equalTo: view.topAnchor),
            bar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            bar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            bar.heightAnchor.constraint(equalToConstant: 66),

            cancelButton.leadingAnchor.constraint(equalTo: bar.leadingAnchor, constant: 16),
            cancelButton.bottomAnchor.constraint(equalTo: bar.bottomAnchor, constant: -12),

            saveButton.trailingAnchor.constraint(equalTo: bar.trailingAnchor, constant: -16),
            saveButton.bottomAnchor.constraint(equalTo: bar.bottomAnchor, constant: -12),

            titleLabel.centerXAnchor.constraint(equalTo: bar.centerXAnchor),
            titleLabel.centerYAnchor.constraint(equalTo: saveButton.centerYAnchor),

            divider.leadingAnchor.constraint(equalTo: bar.leadingAnchor),
            divider.trailingAnchor.constraint(equalTo: bar.trailingAnchor),
            divider.bottomAnchor.constraint(equalTo: bar.bottomAnchor),
            divider.heightAnchor.constraint(equalToConstant: 0.5)
        ])

        scrollView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(scrollView)
        NSLayoutConstraint.activate([
            scrollView.topAnchor.constraint(equalTo: bar.bottomAnchor),
            scrollView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            scrollView.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
    }

    private func configureForm() {
        stack.axis = .vertical
        stack.spacing = 18
        stack.translatesAutoresizingMaskIntoConstraints = false
        scrollView.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: scrollView.contentLayoutGuide.topAnchor, constant: 12),
            stack.leadingAnchor.constraint(equalTo: scrollView.frameLayoutGuide.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: scrollView.frameLayoutGuide.trailingAnchor, constant: -20),
            stack.bottomAnchor.constraint(equalTo: scrollView.contentLayoutGuide.bottomAnchor, constant: -24)
        ])

        urlView.placeholder = "https://..."
        styleTextView(urlView, height: 56, fontSize: 17)
        autofillButton.setTitle("AutoFill Metadata", for: .normal)
        autofillButton.contentHorizontalAlignment = .left
        autofillButton.titleLabel?.font = .systemFont(ofSize: 15)
        autofillButton.addTarget(self, action: #selector(fetchMetadataTapped), for: .touchUpInside)
        addSection(title: "URL", rows: [urlView, autofillButton])

        titleView.placeholder = "Optional"
        styleTextView(titleView, height: 56, fontSize: 17)
        addSection(title: "TITLE", rows: [titleView])

        descriptionView.placeholder = "Optional"
        styleTextView(descriptionView, height: 72, fontSize: 17)
        addSection(title: "DESCRIPTION", rows: [descriptionView])

        // Autocomplete strip — pulls from the user's own tag library
        // (synced from the main app via AppGroup) plus popular tags
        // from other Deepmarks users who bookmarked the same URL.
        tagsView.placeholder = "Optional, space-separated. Prefix with a period for private tags."
        tagsView.text = defaultTags.filter { $0 != "toread" }.joined(separator: " ")
        styleTextView(tagsView, height: 56, fontSize: 17)
        tagsView.delegate = self
        suggestedButton.setTitle("View Suggested Tags", for: .normal)
        suggestedButton.contentHorizontalAlignment = .left
        suggestedButton.titleLabel?.font = .systemFont(ofSize: 15)
        suggestedButton.addTarget(self, action: #selector(showSuggestedTags), for: .touchUpInside)
        let suggestedRow = chevronRow(content: suggestedButton)
        let autoCompleteRow = configureAutoCompleteRow()
        addSection(title: "TAGS", rows: [tagsView, autoCompleteRow, suggestedRow])
        updateAutoCompleteSuggestions()

        readLaterSwitch.isOn = defaultReadLater || defaultTags.contains("toread")
        privacyControl.selectedSegmentIndex = defaultVisibility == "public" ? 1 : 0
        privacyControl.setTitleTextAttributes([.font: UIFont.boldSystemFont(ofSize: 13)], for: .selected)
        addSection(title: "ADVANCED", rows: [
            switchRow(title: "Read Later", control: readLaterSwitch),
            segmentedRow(title: "Privacy", control: privacyControl)
        ])
    }

    private func styleTextView(_ textView: PlaceholderTextView, height: CGFloat, fontSize: CGFloat) {
        textView.delegate = self
        textView.font = .systemFont(ofSize: fontSize)
        textView.backgroundColor = .clear
        textView.textColor = .label
        textView.isScrollEnabled = false
        textView.textContainerInset = UIEdgeInsets(top: 8, left: 0, bottom: 8, right: 0)
        textView.textContainer.lineFragmentPadding = 0
        textView.heightAnchor.constraint(greaterThanOrEqualToConstant: height).isActive = true
    }

    private func addSection(title: String, rows: [UIView]) {
        let section = UIStackView()
        section.axis = .vertical
        section.spacing = 6

        let label = UILabel()
        label.text = title
        label.font = .systemFont(ofSize: 13)
        label.textColor = .secondaryLabel
        label.setContentHuggingPriority(.required, for: .vertical)
        section.addArrangedSubview(label)

        let card = UIStackView()
        card.axis = .vertical
        card.backgroundColor = .secondarySystemGroupedBackground
        card.layer.cornerRadius = 14
        card.layer.masksToBounds = true
        card.isLayoutMarginsRelativeArrangement = true
        card.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 10, leading: 18, bottom: 10, trailing: 18)

        for (index, row) in rows.enumerated() {
            card.addArrangedSubview(row)
            if index < rows.count - 1 {
                card.addArrangedSubview(separator())
            }
        }
        section.addArrangedSubview(card)
        stack.addArrangedSubview(section)
    }

    private func separator() -> UIView {
        let view = UIView()
        view.backgroundColor = .separator
        view.heightAnchor.constraint(equalToConstant: 0.5).isActive = true
        return view
    }

    private func switchRow(title: String, control: UISwitch) -> UIView {
        let row = UIStackView()
        row.axis = .horizontal
        row.alignment = .center
        row.spacing = 12
        row.heightAnchor.constraint(equalToConstant: 40).isActive = true
        let label = UILabel()
        label.text = title
        label.font = .systemFont(ofSize: 17)
        row.addArrangedSubview(label)
        row.addArrangedSubview(UIView())
        row.addArrangedSubview(control)
        return row
    }

    private func segmentedRow(title: String, control: UISegmentedControl) -> UIView {
        let row = UIStackView()
        row.axis = .horizontal
        row.alignment = .center
        row.spacing = 12
        row.heightAnchor.constraint(equalToConstant: 40).isActive = true
        let label = UILabel()
        label.text = title
        label.font = .systemFont(ofSize: 17)
        row.addArrangedSubview(label)
        row.addArrangedSubview(control)
        control.widthAnchor.constraint(greaterThanOrEqualToConstant: 210).isActive = true
        return row
    }

    private func chevronRow(content: UIView) -> UIView {
        let row = UIStackView()
        row.axis = .horizontal
        row.alignment = .center
        row.spacing = 8
        row.heightAnchor.constraint(equalToConstant: 40).isActive = true
        row.addArrangedSubview(content)
        let chevron = UILabel()
        chevron.text = "›"
        chevron.font = .systemFont(ofSize: 22)
        chevron.textColor = .tertiaryLabel
        row.addArrangedSubview(chevron)
        return row
    }

    private func configureAutoCompleteRow() -> UIView {
        autoCompleteScroll.showsHorizontalScrollIndicator = false
        autoCompleteScroll.showsVerticalScrollIndicator = false
        autoCompleteScroll.translatesAutoresizingMaskIntoConstraints = false
        autoCompleteStack.axis = .horizontal
        autoCompleteStack.spacing = 6
        autoCompleteStack.translatesAutoresizingMaskIntoConstraints = false
        autoCompleteScroll.addSubview(autoCompleteStack)
        let heightConstraint = autoCompleteScroll.heightAnchor.constraint(equalToConstant: 0)
        heightConstraint.isActive = true
        autoCompleteHeightConstraint = heightConstraint
        NSLayoutConstraint.activate([
            autoCompleteStack.topAnchor.constraint(equalTo: autoCompleteScroll.topAnchor),
            autoCompleteStack.bottomAnchor.constraint(equalTo: autoCompleteScroll.bottomAnchor),
            autoCompleteStack.leadingAnchor.constraint(equalTo: autoCompleteScroll.leadingAnchor),
            autoCompleteStack.trailingAnchor.constraint(equalTo: autoCompleteScroll.trailingAnchor),
            autoCompleteStack.heightAnchor.constraint(equalTo: autoCompleteScroll.heightAnchor)
        ])
        return autoCompleteScroll
    }

    private func currentlyTypedTagPrefix() -> String {
        let raw = tagsView.text ?? ""
        // Suggest based on the last whitespace/comma-separated token,
        // so typing "react j" only filters against tokens that start
        // with "j". An empty trailing token (after a space) gets a
        // blank prefix, which surfaces the user's all-time most-used
        // tags as ambient picks.
        let lastChar = raw.last
        if let lastChar, lastChar.isWhitespace || lastChar == "," { return "" }
        let parts = raw.split(whereSeparator: { $0.isWhitespace || $0 == "," })
        return parts.last.map { String($0).lowercased() } ?? ""
    }

    private func updateAutoCompleteSuggestions() {
        let prefix = currentlyTypedTagPrefix()
        let alreadyEntered = Set(normalizedTags())
        // User's own tags rank first (most personal). Then popular
        // tags from other Deepmarks users for this URL. Dedup, drop
        // anything already in the tags field.
        var picked: [String] = []
        var seen = Set<String>()
        for source in [userTags, popularTags] {
            for raw in source {
                let tag = raw.lowercased()
                if tag.isEmpty || seen.contains(tag) || alreadyEntered.contains(tag) { continue }
                if !prefix.isEmpty && !tag.hasPrefix(prefix) { continue }
                seen.insert(tag)
                picked.append(tag)
                if picked.count >= 12 { break }
            }
            if picked.count >= 12 { break }
        }
        renderAutoCompleteChips(picked)
    }

    private func renderAutoCompleteChips(_ tags: [String]) {
        autoCompleteStack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        if tags.isEmpty {
            autoCompleteHeightConstraint?.constant = 0
            autoCompleteScroll.isHidden = true
            return
        }
        autoCompleteScroll.isHidden = false
        autoCompleteHeightConstraint?.constant = 32
        for tag in tags {
            let chip = UIButton(type: .system)
            chip.setTitle(tag, for: .normal)
            chip.titleLabel?.font = .systemFont(ofSize: 14)
            chip.setTitleColor(.label, for: .normal)
            chip.backgroundColor = .tertiarySystemFill
            chip.contentEdgeInsets = UIEdgeInsets(top: 4, left: 10, bottom: 4, right: 10)
            chip.layer.cornerRadius = 14
            chip.layer.masksToBounds = true
            chip.addAction(UIAction { [weak self] _ in
                self?.completeTag(tag)
            }, for: .touchUpInside)
            autoCompleteStack.addArrangedSubview(chip)
        }
    }

    private func completeTag(_ tag: String) {
        let raw = tagsView.text ?? ""
        let lastChar = raw.last
        var replaced = raw
        if let lastChar, !lastChar.isWhitespace && lastChar != "," {
            // Replace the partial last token with the chosen tag.
            if let lastSep = raw.lastIndex(where: { $0.isWhitespace || $0 == "," }) {
                replaced = String(raw[..<raw.index(after: lastSep)]) + tag
            } else {
                replaced = tag
            }
        } else {
            replaced = raw + tag
        }
        if !replaced.hasSuffix(" ") { replaced += " " }
        tagsView.text = replaced
        updateAutoCompleteSuggestions()
    }

    // MARK: UITextViewDelegate

    func textViewDidChange(_ textView: UITextView) {
        if textView === tagsView {
            updateAutoCompleteSuggestions()
        }
        scrollActiveTextViewIntoView()
    }

    /** Tracks whichever text view is currently first responder so the
     *  keyboard observer can scroll it above the on-screen keyboard.
     *  Without this the tags field — which sits low in the modal sheet —
     *  routinely got covered when focused. */
    private weak var activeTextView: UITextView?

    func textViewDidBeginEditing(_ textView: UITextView) {
        activeTextView = textView
        // Defer one runloop so the keyboard frame notification (which
        // we use to compute the inset) has fired before we ask the
        // scroll view to bring this rect into view.
        DispatchQueue.main.async { [weak self] in
            self?.scrollActiveTextViewIntoView()
        }
    }

    func textViewDidEndEditing(_ textView: UITextView) {
        if activeTextView === textView { activeTextView = nil }
    }

    private func scrollActiveTextViewIntoView() {
        guard let textView = activeTextView else { return }
        // Convert the text view's frame into scrollView coordinates,
        // pad it a little so the caret isn't flush against the
        // keyboard, and ask the scrollView to bring it into view.
        let targetInTextView: CGRect
        if let selectedRange = textView.selectedTextRange {
            targetInTextView = textView.caretRect(for: selectedRange.end)
        } else {
            targetInTextView = textView.bounds
        }
        let rectInScroll = textView.convert(targetInTextView, to: scrollView)
        let padded = rectInScroll.insetBy(dx: 0, dy: -80)
        scrollView.scrollRectToVisible(padded, animated: true)
    }

    private func fetchPopularTags(for urlString: String) {
        guard let url = URL(string: urlString), url.scheme == "http" || url.scheme == "https" else { return }
        var components = URLComponents(string: "https://api.deepmarks.org/tags/popular")
        components?.queryItems = [URLQueryItem(name: "url", value: urlString)]
        guard let endpoint = components?.url else { return }
        URLSession.shared.dataTask(with: endpoint) { [weak self] data, _, _ in
            guard let self = self else { return }
            var tags: [String] = []
            if
                let data = data,
                let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            {
                tags = (object["tags"] as? [String]) ?? []
            }
            DispatchQueue.main.async {
                self.popularTags = tags
                self.updateAutoCompleteSuggestions()
            }
        }.resume()
    }

    @objc private func fetchMetadataTapped() {
        fetchMetadata()
    }

    private func fetchMetadata() {
        let raw = trimmed(urlView.text)
        guard let url = URL(string: raw), url.scheme == "http" || url.scheme == "https" else { return }
        var components = URLComponents(string: "https://api.deepmarks.org/metadata")
        components?.queryItems = [URLQueryItem(name: "url", value: raw)]
        guard let metadataUrl = components?.url else { return }

        autofillButton.setTitle("Loading Metadata...", for: .normal)
        URLSession.shared.dataTask(with: metadataUrl) { [weak self] data, _, _ in
            guard let self = self else { return }
            var title: String?
            var description: String?
            var tags: [String] = []
            if
                let data = data,
                let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            {
                title = object["title"] as? String
                description = object["description"] as? String
                tags = object["suggestedTags"] as? [String] ?? []
            }
            DispatchQueue.main.async {
                self.autofillButton.setTitle("AutoFill Metadata", for: .normal)
                if self.trimmed(self.titleView.text).isEmpty, let title, !title.isEmpty {
                    self.titleView.text = title
                }
                if self.trimmed(self.descriptionView.text).isEmpty, let description, !description.isEmpty {
                    self.descriptionView.text = description
                }
                self.suggestedTags = tags
                self.suggestedButton.setTitle(tags.isEmpty ? "View Suggested Tags" : "View Suggested Tags (\(tags.count))", for: .normal)
            }
        }.resume()
    }

    @objc private func showSuggestedTags() {
        let alert = UIAlertController(
            title: "Suggested Tags",
            message: suggestedTags.isEmpty ? "No suggested tags yet. Tap AutoFill Metadata first." : nil,
            preferredStyle: .actionSheet
        )
        for tag in suggestedTags {
            alert.addAction(UIAlertAction(title: tag, style: .default) { [weak self] _ in
                self?.appendTag(tag)
            })
        }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        if let popover = alert.popoverPresentationController {
            popover.sourceView = suggestedButton
            popover.sourceRect = suggestedButton.bounds
        }
        present(alert, animated: true)
    }

    private func appendTag(_ tag: String) {
        let normalized = normalizeTag(tag)
        guard !normalized.isEmpty else { return }
        var tags = normalizedTags()
        guard !tags.contains(normalized) else { return }
        tags.append(normalized)
        tagsView.text = tags.joined(separator: " ") + " "
        updateAutoCompleteSuggestions()
    }

    @objc private func cancel() {
        extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
    }

    @objc private func save() {
        let raw = trimmed(urlView.text)
        guard !raw.isEmpty else { return }
        let pendingShare = buildPendingShare()
        let captured = persistPendingShare(pendingShare)
        saveButton.isEnabled = false
        saveButton.setTitle("Saving...", for: .normal)

        // Fast path: for shares with a nsec in the
        // shared Keychain, sign + POST /publish RIGHT HERE inside the
        // extension. Public kind:39701 events and private encrypted
        // kind:30003 item events land on relay.deepmarks.org
        // before the share sheet dismisses, so the user gets instant-
        // publish UX with no main-app-foreground dependency.
        //
        // We still persisted to AppGroup above so the next foreground
        // can update the user's local own-bookmarks store via the JS
        // share-drain; that path checks pendingShare["published"] and
        // skips the relay round-trip. If POST fails we fall through
        // to the existing openInHostApp behavior so nothing's lost.
        if shouldNativePublish(pendingShare) {
            Task {
                let result = await tryNativePublish(pendingShare)
                await MainActor.run {
                    if result {
                        // Stamp the AppGroup record so share-drain knows
                        // not to re-publish.
                        self.markAppGroupShareAsPublished(id: pendingShare["id"] ?? "")
                        self.extensionContext?.completeRequest(
                            returningItems: [],
                            completionHandler: nil
                        )
                    } else {
                        // Fall back to the host-app path. AppGroup
                        // already has the share so share-drain will
                        // pick it up.
                        self.dismissViaHostApp(pendingShare: pendingShare, captured: captured)
                    }
                }
            }
            return
        }

        dismissViaHostApp(pendingShare: pendingShare, captured: captured)
    }

    /// Whether this share is eligible for the native sign-and-POST
    /// fast path.
    private func shouldNativePublish(_ pendingShare: [String: String]) -> Bool {
        let visibility = pendingShare["visibility"] ?? "default"
        guard visibility == "public" || visibility == "private" else { return false }
        guard let ownerPubkey = pendingShare["ownerPubkey"], !ownerPubkey.isEmpty else { return false }
        guard let nsecHex = KeychainSharedStore.loadNsecHex() else { return false }
        guard let signerPubkey = try? NostrSigner.publicKeyHex(nsecHex: nsecHex) else { return false }
        return signerPubkey == ownerPubkey
    }

    /// Returns true if the publish succeeded; false on any error so
    /// the caller can fall back to host-app drain.
    private func tryNativePublish(_ pendingShare: [String: String]) async -> Bool {
        let url = pendingShare["url"] ?? ""
        let title = pendingShare["title"]
        let desc = pendingShare["description"]
        let tags = parseStoredTags(pendingShare["tags"] ?? "")
        let publishedAt = Int(pendingShare["createdAt"] ?? "") ?? Int(Date().timeIntervalSince1970)
        let publishedAtMs = Int64(pendingShare["createdAtMs"] ?? "")
        do {
            if pendingShare["visibility"] == "public" {
                _ = try await NostrPublish.publicBookmark(
                    url: url,
                    title: title?.isEmpty == false ? title : nil,
                    description: desc?.isEmpty == false ? desc : nil,
                    tags: tags,
                    publishedAt: publishedAt,
                    publishedAtMs: publishedAtMs,
                    expectedPubkey: pendingShare["ownerPubkey"]
                )
            } else {
                _ = try await NostrPublish.privateBookmark(
                    url: url,
                    title: title?.isEmpty == false ? title : nil,
                    description: desc?.isEmpty == false ? desc : nil,
                    tags: tags,
                    publishedAt: publishedAt,
                    publishedAtMs: publishedAtMs,
                    expectedPubkey: pendingShare["ownerPubkey"]
                )
            }
            return true
        } catch {
            NSLog("[deepmarks share-extension] native publish failed: \(error)")
            return false
        }
    }

    private func parseStoredTags(_ raw: String) -> [String] {
        raw.split(whereSeparator: { $0.isWhitespace || $0 == "," })
            .map(String.init)
            .filter { !$0.isEmpty }
    }

    /// Mark a pending share as already-published so the JS-side
    /// share-drain skips its publishEvent call but still updates
    /// the local own-bookmarks store via rememberOwnBookmark.
    private func markAppGroupShareAsPublished(id: String) {
        guard !id.isEmpty,
              let defaults = UserDefaults(suiteName: appGroupIdentifier)
        else { return }
        var shares = loadPendingShares(defaults: defaults)
        for i in 0..<shares.count {
            if shares[i]["id"] == id {
                shares[i]["published"] = "1"
            }
        }
        if let data = try? JSONSerialization.data(withJSONObject: shares, options: []) {
            defaults.set(data, forKey: pendingSharesKey)
            defaults.synchronize()
        }
    }

    private func dismissViaHostApp(pendingShare: [String: String], captured: Bool) {
        openInHostApp(pendingShare: pendingShare) { [weak self] opened in
            DispatchQueue.main.async {
                guard let self = self else { return }
                if opened || captured {
                    self.extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
                } else {
                    self.saveButton.isEnabled = true
                    self.saveButton.setTitle("Save", for: .normal)
                    self.showCaptureError()
                }
            }
        }
    }

    private func extractSharedURL(completion: @escaping (URL?) -> Void) {
        guard
            let item = extensionContext?.inputItems.first as? NSExtensionItem,
            let attachments = item.attachments
        else {
            completion(nil)
            return
        }

        let urlType = UTType.url.identifier
        let textTypes = [UTType.plainText.identifier, UTType.text.identifier]

        for attachment in attachments {
            if attachment.hasItemConformingToTypeIdentifier(urlType) {
                attachment.loadItem(forTypeIdentifier: urlType, options: nil) { data, _ in
                    if let url = data as? URL {
                        completion(url)
                    } else if let str = data as? String, let url = URL(string: str) {
                        completion(url)
                    } else {
                        completion(nil)
                    }
                }
                return
            }
        }

        for attachment in attachments {
            for textType in textTypes {
                if attachment.hasItemConformingToTypeIdentifier(textType) {
                    attachment.loadItem(forTypeIdentifier: textType, options: nil) { data, _ in
                        completion(self.extractFirstWebURL(from: (data as? String) ?? ""))
                    }
                    return
                }
            }
        }

        completion(nil)
    }

    private func extractFirstWebURL(from text: String) -> URL? {
        text
            .split(whereSeparator: { $0.isWhitespace })
            .lazy
            .map { $0.trimmingCharacters(in: CharacterSet(charactersIn: ".,;:!?)\"]}'")) }
            .compactMap { URL(string: String($0)) }
            .first { $0.scheme == "http" || $0.scheme == "https" }
    }

    private func openInHostApp(pendingShare: [String: String], completion: @escaping (Bool) -> Void) {
        var components = URLComponents()
        components.scheme = "deepmarks"
        components.host = "save"
        let queryItems = [
            URLQueryItem(name: "pendingShareId", value: pendingShare["id"]),
            URLQueryItem(name: "url", value: pendingShare["url"]),
            URLQueryItem(name: "title", value: pendingShare["title"]),
            URLQueryItem(name: "description", value: pendingShare["description"]),
            URLQueryItem(name: "tags", value: pendingShare["tags"]),
            URLQueryItem(name: "readLater", value: pendingShare["readLater"]),
            URLQueryItem(name: "autosave", value: "1"),
            URLQueryItem(name: "visibility", value: pendingShare["visibility"])
        ]
        components.queryItems = queryItems.filter { !($0.value ?? "").isEmpty || $0.name == "readLater" || $0.name == "autosave" || $0.name == "visibility" }
        guard let appUrl = components.url else {
            completion(false)
            return
        }
        extensionContext?.open(appUrl) { [weak self] opened in
            if opened {
                completion(true)
            } else {
                DispatchQueue.main.async {
                    self?.openViaResponderChain(appUrl, completion: completion)
                }
            }
        }
    }

    private func openViaResponderChain(_ appUrl: URL, completion: @escaping (Bool) -> Void) {
        let selector = sel_registerName("openURL:")
        var responder: UIResponder? = self
        while let r = responder {
            if r.responds(to: selector) {
                _ = r.perform(selector, with: appUrl)
                completion(true)
                return
            }
            responder = r.next
        }
        completion(false)
    }

    private func showCaptureError() {
        let alert = UIAlertController(
            title: "Could not save bookmark",
            message: "Deepmarks could not capture this share. Open Deepmarks once, then try sharing again.",
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        present(alert, animated: true)
    }

    private func buildPendingShare() -> [String: String] {
        let nowMs = Int(Date().timeIntervalSince1970 * 1000)
        return [
            "id": UUID().uuidString,
            "url": trimmed(urlView.text),
            "title": trimmed(titleView.text),
            "description": trimmed(descriptionView.text),
            "tags": normalizedTags().joined(separator: " "),
            "readLater": readLaterValue(),
            "visibility": visibilityValue(),
            "ownerPubkey": activePubkey,
            "autosave": "1",
            "createdAt": String(nowMs / 1000),
            "createdAtMs": String(nowMs)
        ]
    }

    private func readLaterValue() -> String {
        if readLaterSwitch.isOn { return "1" }
        return (defaultReadLater || defaultTags.contains("toread")) ? "0" : ""
    }

    private func visibilityValue() -> String {
        switch privacyControl.selectedSegmentIndex {
        case 1:
            return "public"
        case 0:
            return "private"
        default:
            return defaultVisibility == "public" ? "public" : "private"
        }
    }

    private func persistPendingShare(_ pendingShare: [String: String]) -> Bool {
        guard let defaults = UserDefaults(suiteName: appGroupIdentifier) else { return false }
        var shares = loadPendingShares(defaults: defaults)
        shares.removeAll { $0["id"] == pendingShare["id"] }
        shares.append(pendingShare)
        if shares.count > 50 {
            shares = Array(shares.suffix(50))
        }
        do {
            let data = try JSONSerialization.data(withJSONObject: shares, options: [])
            defaults.set(data, forKey: pendingSharesKey)
            defaults.synchronize()
            return true
        } catch {
            return false
        }
    }

    private func loadPendingShares(defaults: UserDefaults) -> [[String: String]] {
        guard
            let data = defaults.data(forKey: pendingSharesKey),
            let decoded = try? JSONSerialization.jsonObject(with: data) as? [[String: String]]
        else {
            return []
        }
        return decoded
    }

    private func normalizedTags() -> [String] {
        var tags: [String] = []
        var seen = Set<String>()
        for part in tagsView.text.split(whereSeparator: { $0.isWhitespace || $0 == "," }) {
            let tag = normalizeTag(String(part))
            if tag.isEmpty || seen.contains(tag) { continue }
            seen.insert(tag)
            tags.append(tag)
        }
        if readLaterSwitch.isOn && !seen.contains("toread") {
            tags.append("toread")
        }
        return tags
    }

    private func normalizeTag(_ raw: String) -> String {
        let tag = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "#"))
            .lowercased()
        return tag.count <= 48 ? tag : ""
    }

    private func normalizePubkey(_ raw: String) -> String {
        let pubkey = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return pubkey.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil ? pubkey : ""
    }

    private func trimmed(_ raw: String?) -> String {
        (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func observeKeyboard() {
        keyboardObservers.append(NotificationCenter.default.addObserver(
            forName: UIResponder.keyboardWillChangeFrameNotification,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard
                let self,
                let frame = notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect
            else { return }
            let converted = self.view.convert(frame, from: nil)
            let overlap = max(0, self.view.bounds.maxY - converted.minY)
            self.scrollView.contentInset.bottom = overlap + 96
            self.scrollView.verticalScrollIndicatorInsets.bottom = overlap + 16
            // Now that the inset reflects the keyboard, scroll the
            // focused text view into the visible area. Especially
            // important for the tags field, which sits near the
            // bottom of the modal and used to get covered.
            self.scrollActiveTextViewIntoView()
        })
        keyboardObservers.append(NotificationCenter.default.addObserver(
            forName: UIResponder.keyboardWillHideNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.scrollView.contentInset.bottom = 0
            self?.scrollView.verticalScrollIndicatorInsets.bottom = 0
        })
    }

    deinit {
        for observer in keyboardObservers {
            NotificationCenter.default.removeObserver(observer)
        }
    }
}
