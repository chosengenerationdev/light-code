package dev.chosengeneration.lightcode

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.options.Configurable
import com.intellij.ui.components.JBCheckBox
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.FormBuilder
import javax.swing.JComponent
import javax.swing.JPanel

/**
 * How this IDE starts Light Code.
 *
 * Deliberately small. Everything about the *product* — providers, agents, approvals, tools — is
 * configured inside Light Code itself, in the same panels the VS Code extension uses, and putting
 * any of it here as well would be two places holding one setting. What belongs here is only what
 * IntelliJ has to know to start the thing at all.
 *
 * **No credential ever lands here.** Keys, certificates and tokens are the server's, stored the way
 * it stores them. A field in this dialog would put one in IntelliJ's own settings file, which is a
 * second place a secret lives and a second place to forget about it.
 */
@Service(Service.Level.APP)
@State(name = "LightCodeSettings", storages = [Storage("light-code.xml")])
class LightCodeSettings : PersistentStateComponent<LightCodeSettings.State> {

  data class State(
    /**
     * The command that starts the server. Empty means `npx --yes @chosengeneration/light-code@latest`.
     *
     * Overridden for an offline machine, an internal registry, or a checkout being worked on —
     * `node /path/to/light-code/apps/host/dist/cli.js` is the form that runs a local build.
     */
    var command: String = "",
    /**
     * Whether to start it with `--no-token`.
     *
     * On by default, and this is the honest trade rather than an oversight: the panel is handed a
     * URL programmatically, so a one-time launch fragment protects nothing it does not already
     * have. Origin and Host are still checked, so no page in a browser can reach the port — but
     * any *program* running as you can. Somebody who does not accept that turns it off and pastes
     * the launch link themselves.
     */
    var noToken: Boolean = true,
    /** Anything else to pass, space separated. `--public-url`, `--data-dir`, and so on. */
    var extraArguments: String = "",
  )

  private var state = State()

  override fun getState(): State = state

  override fun loadState(loaded: State) {
    state = loaded
  }

  companion object {
    fun getInstance(): LightCodeSettings =
      ApplicationManager.getApplication().getService(LightCodeSettings::class.java)
  }
}

/** Settings → Tools → Light Code. */
class LightCodeConfigurable : Configurable {

  private val command = JBTextField()
  private val extra = JBTextField()
  private val noToken = JBCheckBox("Start with --no-token (recommended on a machine you trust)")
  private var panel: JPanel? = null

  override fun getDisplayName(): String = "Light Code"

  override fun createComponent(): JComponent {
    val built =
      FormBuilder.createFormBuilder()
        .addLabeledComponent("Start command", command)
        .addComponentToRightColumn(
          com.intellij.ui.components.JBLabel(
            "<html>Leave empty for <code>npx --yes @chosengeneration/light-code@latest</code>.<br>" +
              "For a local build: <code>node C:\\path\\to\\apps\\host\\dist\\cli.js</code></html>",
          ),
        )
        .addLabeledComponent("Extra arguments", extra)
        .addComponent(noToken)
        .addComponentFillVertically(JPanel(), 0)
        .panel
    panel = built
    reset()
    return built
  }

  override fun isModified(): Boolean {
    val state = LightCodeSettings.getInstance().state
    return command.text != state.command ||
      extra.text != state.extraArguments ||
      noToken.isSelected != state.noToken
  }

  override fun apply() {
    val state = LightCodeSettings.getInstance().state
    state.command = command.text.trim()
    state.extraArguments = extra.text.trim()
    state.noToken = noToken.isSelected
    /*
     * Nothing is restarted here, and the dialog says so rather than pretending.
     *
     * A running server was started with the old command; changing the text does not move it. The
     * alternative — tearing down a live session when somebody edits a field — would throw away a
     * conversation to apply a setting that only matters at the next start.
     */
  }

  override fun reset() {
    val state = LightCodeSettings.getInstance().state
    command.text = state.command
    extra.text = state.extraArguments
    noToken.isSelected = state.noToken
  }
}
