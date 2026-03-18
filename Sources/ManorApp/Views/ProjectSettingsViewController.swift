import AppKit
import ManorCore

// MARK: - Project Settings View Controller

/// Sheet for viewing and editing a project's worktree settings.
@MainActor
final class ProjectSettingsViewController: NSViewController {

    // MARK: State

    private var project: ProjectModel
    private let onSave: (ProjectModel) -> Void

    // MARK: Controls

    private let nameField = NSTextField()
    private let repoPathField = NSTextField()
    private let worktreeDirField = NSTextField()
    private var setupTextView: NSTextView!
    private var teardownTextView: NSTextView!

    // MARK: Init

    init(project: ProjectModel, onSave: @escaping (ProjectModel) -> Void) {
        self.project = project
        self.onSave = onSave
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) not implemented")
    }

    // MARK: View Lifecycle

    override func loadView() {
        view = NSView(frame: NSRect(x: 0, y: 0, width: 520, height: 500))
        view.wantsLayer = true
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        buildUI()
        populateFields()
    }

    // MARK: - UI Construction

    private func buildUI() {
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)

        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: view.topAnchor, constant: 20),
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -20),
        ])

        // Title
        let titleLabel = makeLabel("Project Settings", size: 15, weight: .semibold)
        stack.addArrangedSubview(titleLabel)

        stack.addArrangedSubview(makeSeparator())

        // Project Name
        stack.addArrangedSubview(makeLabel("Project Name", size: 11, weight: .medium))
        nameField.placeholderString = "My Project"
        nameField.translatesAutoresizingMaskIntoConstraints = false
        stack.addArrangedSubview(nameField)
        nameField.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true

        // Repository Path
        stack.addArrangedSubview(makeLabel("Repository Path", size: 11, weight: .medium))
        let repoRow = makePathRow(field: repoPathField, placeholder: "/path/to/repo", action: #selector(browseRepository))
        stack.addArrangedSubview(repoRow)
        repoRow.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true

        stack.addArrangedSubview(makeSeparator())

        // Worktree Directory
        stack.addArrangedSubview(makeLabel("Worktree Directory", size: 11, weight: .medium))
        let secondaryLabel = makeLabel("Worktrees for this project will be created inside this directory.", size: 10, weight: .regular)
        secondaryLabel.textColor = .secondaryLabelColor
        stack.addArrangedSubview(secondaryLabel)
        let worktreeRow = makePathRow(field: worktreeDirField, placeholder: "/path/to/worktrees", action: #selector(browseWorktreeDir))
        stack.addArrangedSubview(worktreeRow)
        worktreeRow.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true

        stack.addArrangedSubview(makeSeparator())

        // Setup Script
        stack.addArrangedSubview(makeLabel("Setup Script", size: 11, weight: .medium))
        let setupNote = makeLabel("Runs after a worktree is created.", size: 10, weight: .regular)
        setupNote.textColor = .secondaryLabelColor
        stack.addArrangedSubview(setupNote)
        let (setupScroll, setupTV) = makeScriptEditor(height: 80)
        self.setupTextView = setupTV
        stack.addArrangedSubview(setupScroll)
        setupScroll.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true

        // Teardown Script
        stack.addArrangedSubview(makeLabel("Teardown Script", size: 11, weight: .medium))
        let teardownNote = makeLabel("Runs before a worktree is deleted.", size: 10, weight: .regular)
        teardownNote.textColor = .secondaryLabelColor
        stack.addArrangedSubview(teardownNote)
        let (teardownScroll, teardownTV) = makeScriptEditor(height: 80)
        self.teardownTextView = teardownTV
        stack.addArrangedSubview(teardownScroll)
        teardownScroll.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true

        // Buttons
        let buttonRow = makeButtonRow()
        view.addSubview(buttonRow)
        buttonRow.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            buttonRow.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -20),
            buttonRow.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -16),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: buttonRow.topAnchor, constant: -12),
        ])
    }

    // MARK: - Field Helpers

    private func makeLabel(_ text: String, size: CGFloat, weight: NSFont.Weight) -> NSTextField {
        let label = NSTextField(labelWithString: text)
        label.font = .systemFont(ofSize: size, weight: weight)
        label.translatesAutoresizingMaskIntoConstraints = false
        return label
    }

    private func makeSeparator() -> NSBox {
        let sep = NSBox()
        sep.boxType = .separator
        sep.translatesAutoresizingMaskIntoConstraints = false
        return sep
    }

    private func makePathRow(field: NSTextField, placeholder: String, action: Selector) -> NSView {
        field.placeholderString = placeholder
        field.translatesAutoresizingMaskIntoConstraints = false

        let button = NSButton(title: "Browse…", target: self, action: action)
        button.bezelStyle = .rounded
        button.controlSize = .small
        button.translatesAutoresizingMaskIntoConstraints = false

        let row = NSView()
        row.translatesAutoresizingMaskIntoConstraints = false
        row.addSubview(field)
        row.addSubview(button)

        NSLayoutConstraint.activate([
            field.leadingAnchor.constraint(equalTo: row.leadingAnchor),
            field.centerYAnchor.constraint(equalTo: row.centerYAnchor),
            field.trailingAnchor.constraint(equalTo: button.leadingAnchor, constant: -8),

            button.trailingAnchor.constraint(equalTo: row.trailingAnchor),
            button.centerYAnchor.constraint(equalTo: row.centerYAnchor),
            button.widthAnchor.constraint(equalToConstant: 80),

            row.heightAnchor.constraint(equalToConstant: 24),
        ])

        return row
    }

    private func makeScriptEditor(height: CGFloat) -> (NSScrollView, NSTextView) {
        let scrollView = NSScrollView()
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = false
        scrollView.autohidesScrollers = true
        scrollView.borderType = .bezelBorder
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        scrollView.heightAnchor.constraint(equalToConstant: height).isActive = true

        let textView = NSTextView()
        textView.isEditable = true
        textView.isRichText = false
        textView.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        textView.textColor = .labelColor
        textView.backgroundColor = .textBackgroundColor
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.autoresizingMask = [.width]
        textView.isVerticallyResizable = true
        textView.textContainer?.widthTracksTextView = true

        scrollView.documentView = textView
        return (scrollView, textView)
    }

    private func makeButtonRow() -> NSView {
        let cancelButton = NSButton(title: "Cancel", target: self, action: #selector(cancel))
        cancelButton.bezelStyle = .rounded
        cancelButton.keyEquivalent = "\u{1b}" // Escape

        let saveButton = NSButton(title: "Save", target: self, action: #selector(save))
        saveButton.bezelStyle = .rounded
        saveButton.keyEquivalent = "\r"

        let row = NSStackView(views: [cancelButton, saveButton])
        row.orientation = .horizontal
        row.spacing = 8
        row.translatesAutoresizingMaskIntoConstraints = false
        return row
    }

    // MARK: - Data

    private func populateFields() {
        nameField.stringValue = project.name
        repoPathField.stringValue = project.path.path
        worktreeDirField.stringValue = ""
        setupTextView.string = project.setupScript ?? ""
        teardownTextView.string = project.teardownScript ?? ""
    }

    private func collectSettings() -> ProjectModel {
        var updated = project
        updated.name = nameField.stringValue
        updated.path = URL(fileURLWithPath: repoPathField.stringValue)
        updated.setupScript = setupTextView.string.isEmpty ? nil : setupTextView.string
        updated.teardownScript = teardownTextView.string.isEmpty ? nil : teardownTextView.string
        return updated
    }

    // MARK: - Browse Actions

    @objc private func browseRepository() {
        presentFolderPicker(field: repoPathField)
    }

    @objc private func browseWorktreeDir() {
        presentFolderPicker(field: worktreeDirField)
    }

    private func presentFolderPicker(field: NSTextField) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        if !field.stringValue.isEmpty {
            panel.directoryURL = URL(fileURLWithPath: field.stringValue)
        }
        panel.beginSheetModal(for: view.window!) { [weak self] response in
            guard response == .OK, let url = panel.url else { return }
            field.stringValue = url.path
            _ = self // suppress warning
        }
    }

    // MARK: - Button Actions

    @objc private func save() {
        let updated = collectSettings()
        onSave(updated)
        dismiss(nil)
    }

    @objc private func cancel() {
        dismiss(nil)
    }
}

// MARK: - Convenience Presentation

extension ProjectSettingsViewController {
    /// Present as a sheet on the given window.
    func presentAsSheet(on window: NSWindow) {
        window.contentViewController?.presentAsSheet(self)
    }
}
