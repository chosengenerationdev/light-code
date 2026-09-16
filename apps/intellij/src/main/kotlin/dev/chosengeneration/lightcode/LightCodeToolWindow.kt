package dev.chosengeneration.lightcode

import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.service
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.ui.jcef.JBCefApp
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.panels.Wrapper
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.ContentFactory
import javax.swing.JComponent
import javax.swing.SwingConstants

/**
 * The Light Code panel.
 *
 * ## Why a browser panel rather than Swing
 *
 * Because the UI already exists and is React. `packages/ui` is shared by the VS Code webview and
 * the Node host's browser page, and it carries the whole product: the chat, approvals with their
 * computed diffs, every settings tab, the agent team, the diagrams. Rebuilding that in Swing would
 * be a second implementation of one interface — the shape this project has paid for more than any
 * other — and it would start behind and stay behind.
 *
 * So the panel is a Chromium view pointed at the local server, and every feature arrives with it.
 *
 * ## What is deliberately not here
 *
 * IDE-native touches: opening a file at a line from the chat, using IntelliJ's own diff viewer for
 * an approval, following the IDE theme. Those need a channel from the page back into Kotlin
 * (`JBCefJSQuery` is the one), and each is an addition rather than a rewrite. The product works
 * without them; it is simply less woven in than the VS Code extension is.
 */
class LightCodeToolWindow : ToolWindowFactory, DumbAware {

  override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
    val panel = LightCodePanel(project)
    Disposer.register(toolWindow.disposable, panel)
    val content = ContentFactory.getInstance().createContent(panel.component(), null, false)
    toolWindow.contentManager.addContent(content)
  }
}

/** The panel's contents: a message while the server starts, then the browser. */
class LightCodePanel(private val project: Project) : Disposable {

  private val wrapper = Wrapper()
  private var browser: JBCefBrowser? = null

  init {
    /*
     * JCEF is present in every current IntelliJ-based IDE, and it can still be absent: a custom
     * JDK without it, or an administrator who has switched it off. Said plainly rather than
     * throwing, because a stack trace in the event log is not an answer somebody can act on.
     */
    if (!JBCefApp.isSupported()) {
      wrapper.setContent(
        message(
          "This IDE cannot show an embedded browser, so Light Code has nothing to draw in.\n" +
            "It is usually switched on under Help → Find Action → Registry → ide.browser.jcef.enabled.",
        ),
      )
    } else {
      wrapper.setContent(message("Starting Light Code…"))
      start()
    }
  }

  fun component(): JComponent = wrapper

  private fun start() {
    val server = project.service<LightCodeServer>()
    server
      .url()
      .whenComplete { url, problem ->
        /*
         * Back to the UI thread before touching a component.
         *
         * The future completes on whichever thread read the process output, and Swing is not
         * thread-safe. Getting this wrong produces a panel that is blank or painted once and never
         * again, intermittently, which is close to undiagnosable from a bug report.
         */
        ApplicationManager.getApplication().invokeLater {
          if (problem != null) {
            wrapper.setContent(message(problem.cause?.message ?: problem.message ?: "Light Code could not start."))
            return@invokeLater
          }
          show(url)
        }
      }
  }

  private fun show(url: String) {
    val view = JBCefBrowser.createBuilder().setUrl(url).build()
    Disposer.register(this, view)
    browser = view
    wrapper.setContent(view.component)
  }

  private fun message(text: String): JComponent =
    JBLabel("<html>${text.replace("\n", "<br>")}</html>").apply {
      horizontalAlignment = SwingConstants.CENTER
    }

  /*
   * The browser goes with the panel; the *server* does not.
   *
   * Closing the tool window should not throw away the conversation, the MCP connections and the
   * Python worker — that is exactly the bug the extension had when its bridge was created per
   * webview, and the Node host had when a session was built per event stream. The server belongs
   * to the project and is disposed with it.
   */
  override fun dispose() {
    browser = null
  }
}
