import AppKit
import ManorCore

// MARK: - Project Settings View Controller

final class ProjectSettingsViewController: NSViewController {
    var projectName: String = ""
    var setupScript: String = ""
    var teardownScript: String = ""
    var defaultRunCommand: String = ""

    var onSave: (() -> Void)?
    var onCancel: (() -> Void)?

    private var setupField: NSTextField!
    private var teardownField: NSTextField!
    private var runCommandField: NSTextField!

    override func loadView() {
        let panel = NSView(frame: NSRect(x: 0, y: 0, width: 420, height: 300))
        self.view = panel

        let titleLabel = makeLabel(
            "\(projectName) — Project Settings",
            font: .systemFont(ofSize: 13, weight: .semibold)
        )
        titleLabel.frame = CGRect(x: 16, y: 268, width: 388, height: 20)

        let setupLabel = makeLabel("Setup script:", font: .systemFont(ofSize: 12))
        setupLabel.frame = CGRect(x: 16, y: 232, width: 388, height: 18)
        setupField = makeTextField(placeholder: "e.g. npm install && npx prisma migrate")
        setupField.stringValue = setupScript
        setupField.frame = CGRect(x: 16, y: 210, width: 388, height: 22)

        let teardownLabel = makeLabel("Teardown script:", font: .systemFont(ofSize: 12))
        teardownLabel.frame = CGRect(x: 16, y: 182, width: 388, height: 18)
        teardownField = makeTextField(placeholder: "e.g. docker compose down")
        teardownField.stringValue = teardownScript
        teardownField.frame = CGRect(x: 16, y: 160, width: 388, height: 22)

        let runLabel = makeLabel("Default run command:", font: .systemFont(ofSize: 12))
        runLabel.frame = CGRect(x: 16, y: 132, width: 388, height: 18)
        runCommandField = makeTextField(placeholder: "e.g. npm run dev")
        runCommandField.stringValue = defaultRunCommand
        runCommandField.frame = CGRect(x: 16, y: 110, width: 388, height: 22)

        let helpLabel = makeLabel(
            "The run command appears as a ▶ button on worktree rows in the sidebar. Setup and teardown scripts run automatically when worktrees are created or deleted.",
            font: .systemFont(ofSize: 10)
        )
        helpLabel.textColor = .secondaryLabelColor
        helpLabel.frame = CGRect(x: 16, y: 58, width: 388, height: 46)
        helpLabel.maximumNumberOfLines = 3
        helpLabel.lineBreakMode = .byWordWrapping

        let btnCancel = NSButton(title: "Cancel", target: self, action: #selector(cancelAction))
        btnCancel.bezelStyle = .rounded
        btnCancel.frame = CGRect(x: 224, y: 16, width: 80, height: 32)

        let btnSave = NSButton(title: "Save", target: self, action: #selector(saveAction))
        btnSave.bezelStyle = .rounded
        btnSave.keyEquivalent = "\r"
        btnSave.frame = CGRect(x: 316, y: 16, width: 88, height: 32)

        for v in [titleLabel, setupLabel, setupField!, teardownLabel, teardownField!,
                  runLabel, runCommandField!, helpLabel, btnCancel, btnSave] {
            panel.addSubview(v)
        }
    }

    @objc private func saveAction() {
        onSave?()
    }

    @objc private func cancelAction() {
        onCancel?()
    }

    private func makeLabel(_ text: String, font: NSFont) -> NSTextField {
        let tf = NSTextField(labelWithString: text)
        tf.font = font
        tf.textColor = .labelColor
        tf.isEditable = false
        tf.isSelectable = false
        tf.isBordered = false
        tf.backgroundColor = .clear
        return tf
    }

    private func makeTextField(placeholder: String) -> NSTextField {
        let tf = NSTextField()
        tf.placeholderString = placeholder
        tf.font = .systemFont(ofSize: 11)
        tf.isBordered = true
        tf.bezelStyle = .roundedBezel
        return tf
    }

    func collectValues() -> (setup: String?, teardown: String?, run: String?) {
        let setup = setupField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let teardown = teardownField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let run = runCommandField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        return (
            setup.isEmpty ? nil : setup,
            teardown.isEmpty ? nil : teardown,
            run.isEmpty ? nil : run
        )
    }
}
