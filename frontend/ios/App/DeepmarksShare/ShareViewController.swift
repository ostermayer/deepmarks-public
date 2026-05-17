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

class ShareViewController: UIViewController {
    private let appGroupIdentifier = "group.org.deepmarks.app.shared"
    private let pendingSharesKey = "deepmarks-pending-shares-v1"
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
    private let privacyControl = UISegmentedControl(items: ["Default", "Public", "Private"])
    private var suggestedTags: [String] = []
    private var keyboardObservers: [NSObjectProtocol] = []

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor.systemGroupedBackground
        configureTopBar()
        configureForm()
        observeKeyboard()
        extractSharedURL { [weak self] url in
            DispatchQueue.main.async {
                guard let self = self else { return }
                if let url {
                    self.urlView.text = url.absoluteString
                    self.fetchMetadata()
                }
            }
        }
    }

    private func configureTopBar() {
        let bar = UIView()
        bar.translatesAutoresizingMaskIntoConstraints = false
        bar.backgroundColor = .systemBackground
        view.addSubview(bar)

        let cancelButton = UIButton(type: .system)
        cancelButton.setTitle("Cancel", for: .normal)
        cancelButton.titleLabel?.font = .systemFont(ofSize: 20)
        cancelButton.addTarget(self, action: #selector(cancel), for: .touchUpInside)

        let titleLabel = UILabel()
        titleLabel.text = "Save Link"
        titleLabel.font = .boldSystemFont(ofSize: 20)
        titleLabel.textAlignment = .center

        saveButton.setTitle("Save", for: .normal)
        saveButton.titleLabel?.font = .systemFont(ofSize: 20)
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
        stack.spacing = 26
        stack.translatesAutoresizingMaskIntoConstraints = false
        scrollView.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: scrollView.contentLayoutGuide.topAnchor, constant: 12),
            stack.leadingAnchor.constraint(equalTo: scrollView.frameLayoutGuide.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: scrollView.frameLayoutGuide.trailingAnchor, constant: -20),
            stack.bottomAnchor.constraint(equalTo: scrollView.contentLayoutGuide.bottomAnchor, constant: -28)
        ])

        urlView.placeholder = "https://..."
        styleTextView(urlView, height: 88, fontSize: 20)
        autofillButton.setTitle("AutoFill Metadata", for: .normal)
        autofillButton.contentHorizontalAlignment = .left
        autofillButton.titleLabel?.font = .systemFont(ofSize: 20)
        autofillButton.addTarget(self, action: #selector(fetchMetadataTapped), for: .touchUpInside)
        addSection(title: "URL", rows: [urlView, autofillButton])

        titleView.placeholder = "Optional"
        styleTextView(titleView, height: 92, fontSize: 20)
        addSection(title: "TITLE", rows: [titleView])

        descriptionView.placeholder = "Optional"
        styleTextView(descriptionView, height: 92, fontSize: 20)
        addSection(title: "DESCRIPTION", rows: [descriptionView])

        tagsView.placeholder = "Optional, space-separated. Start typing to see suggestions. Tags beginning with a period are private."
        styleTextView(tagsView, height: 112, fontSize: 20)
        suggestedButton.setTitle("View Suggested Tags", for: .normal)
        suggestedButton.contentHorizontalAlignment = .left
        suggestedButton.titleLabel?.font = .systemFont(ofSize: 20)
        suggestedButton.addTarget(self, action: #selector(showSuggestedTags), for: .touchUpInside)
        let suggestedRow = chevronRow(content: suggestedButton)
        addSection(title: "TAGS", rows: [tagsView, suggestedRow])

        privacyControl.selectedSegmentIndex = 0
        privacyControl.setTitleTextAttributes([.font: UIFont.boldSystemFont(ofSize: 14)], for: .selected)
        addSection(title: "ADVANCED", rows: [
            switchRow(title: "Read Later", control: readLaterSwitch),
            segmentedRow(title: "Privacy", control: privacyControl)
        ])
    }

    private func styleTextView(_ textView: PlaceholderTextView, height: CGFloat, fontSize: CGFloat) {
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
        section.spacing = 8

        let label = UILabel()
        label.text = title
        label.font = .systemFont(ofSize: 14)
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
        row.heightAnchor.constraint(equalToConstant: 44).isActive = true
        let label = UILabel()
        label.text = title
        label.font = .systemFont(ofSize: 20)
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
        row.heightAnchor.constraint(equalToConstant: 44).isActive = true
        let label = UILabel()
        label.text = title
        label.font = .systemFont(ofSize: 20)
        row.addArrangedSubview(label)
        row.addArrangedSubview(control)
        control.widthAnchor.constraint(greaterThanOrEqualToConstant: 236).isActive = true
        return row
    }

    private func chevronRow(content: UIView) -> UIView {
        let row = UIStackView()
        row.axis = .horizontal
        row.alignment = .center
        row.spacing = 8
        row.heightAnchor.constraint(equalToConstant: 44).isActive = true
        row.addArrangedSubview(content)
        let chevron = UILabel()
        chevron.text = "›"
        chevron.font = .systemFont(ofSize: 28)
        chevron.textColor = .tertiaryLabel
        row.addArrangedSubview(chevron)
        return row
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
        tagsView.text = tags.joined(separator: " ")
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
        [
            "id": UUID().uuidString,
            "url": trimmed(urlView.text),
            "title": trimmed(titleView.text),
            "description": trimmed(descriptionView.text),
            "tags": normalizedTags().joined(separator: " "),
            "readLater": readLaterSwitch.isOn ? "1" : "0",
            "visibility": visibilityValue(),
            "autosave": "1",
            "createdAt": String(Int(Date().timeIntervalSince1970))
        ]
    }

    private func visibilityValue() -> String {
        switch privacyControl.selectedSegmentIndex {
        case 1:
            return "public"
        case 2:
            return "private"
        default:
            return "default"
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
            self.scrollView.contentInset.bottom = overlap + 16
            self.scrollView.verticalScrollIndicatorInsets.bottom = overlap
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
