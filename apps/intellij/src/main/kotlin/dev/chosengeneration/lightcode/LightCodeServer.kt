package dev.chosengeneration.lightcode

import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.execution.process.OSProcessHandler
import com.intellij.execution.process.ProcessAdapter
import com.intellij.execution.process.ProcessEvent
import com.intellij.execution.process.ProcessOutputTypes
import com.intellij.openapi.Disposable
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.thisLogger
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Key
import com.intellij.openapi.util.SystemInfo
import java.io.File
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

/**
 * The Light Code server that belongs to one project.
 *
 * ## Why a child process rather than a port of the product
 *
 * Because the port already exists. `apps/host` is a Node server that runs the same core, the same
 * bridge and the same React UI as the VS Code extension — it was built so the product would have a
 * second home, and this is a third home that can simply use the second one. Reimplementing the
 * agent loop, the providers, MCP, the Python worker and the whole UI in Kotlin would be a separate
 * product pretending to be the same one, and the two would drift within a month.
 *
 * So the plugin's entire job is: start it, find out where it went, show it, and stop it.
 *
 * ## One server per project, not per window
 *
 * The workspace root is passed at startup and everything the session does is relative to it, so
 * two projects need two servers. Tying it to the project's lifetime also answers disposal: when
 * the project closes, the process goes with it.
 */
@Service(Service.Level.PROJECT)
class LightCodeServer(private val project: Project) : Disposable {

  private var handler: OSProcessHandler? = null
  private var started: CompletableFuture<String>? = null

  /**
   * The URL to show, starting the server if it is not already running.
   *
   * Returned as a future because starting means spawning a process and waiting for it to say where
   * it landed — which must not happen on the UI thread, and which the caller wants to show a
   * "starting…" state for rather than freeze behind.
   */
  @Synchronized
  fun url(): CompletableFuture<String> {
    started?.let { existing ->
      if (!existing.isCompletedExceptionally) return existing
    }
    val future = CompletableFuture<String>()
    started = future
    start(future)
    return future
  }

  private fun start(future: CompletableFuture<String>) {
    val settings = LightCodeSettings.getInstance()
    val command =
      try {
        commandLine(settings)
      } catch (problem: IllegalStateException) {
        future.completeExceptionally(problem)
        return
      }

    thisLogger().info("starting: ${command.commandLineString}")

    val process =
      try {
        OSProcessHandler(command)
      } catch (problem: Exception) {
        future.completeExceptionally(
          IllegalStateException(
            "Could not start Light Code: ${problem.message}. " +
              "Check the command in Settings → Tools → Light Code.",
            problem,
          ),
        )
        return
      }

    handler = process

    /*
     * The URL is read from a line the server prints for exactly this purpose.
     *
     * `--print-url` emits `light-code-url: <url>` and nothing else on that line. The banner around
     * it is prose written for a person — it wraps, it explains, and what it says changes with the
     * flags — so scraping that would be a plugin broken by the next reworded sentence.
     */
    val errors = StringBuilder()
    process.addProcessListener(
      object : ProcessAdapter() {
        override fun onTextAvailable(event: ProcessEvent, outputType: Key<*>) {
          val line = event.text.trim()
          if (outputType == ProcessOutputTypes.STDERR) {
            // Kept, and used only if the process dies: a warning on a healthy start is noise.
            errors.append(line).append('\n')
          }
          val prefix = "light-code-url:"
          if (line.startsWith(prefix) && !future.isDone) {
            future.complete(line.removePrefix(prefix).trim())
          }
        }

        override fun processTerminated(event: ProcessEvent) {
          if (!future.isDone) {
            future.completeExceptionally(
              IllegalStateException(
                "Light Code exited with code ${event.exitCode} before saying where it was " +
                  "listening.\n${errors.toString().takeLast(2000)}",
              ),
            )
          }
        }
      },
    )
    process.startNotify()

    /*
     * A start that never finishes has to fail, or the panel spins for ever.
     *
     * The same rule the server itself learned about its own connection test: a request with no
     * deadline cannot fail, and something that cannot fail cannot report.
     */
    future.orTimeout(60, TimeUnit.SECONDS)
  }

  private fun commandLine(settings: LightCodeSettings): GeneralCommandLine {
    val root = project.basePath ?: throw IllegalStateException("This project has no directory on disk.")

    val configured = settings.state.command.trim()
    val parts =
      if (configured.isNotEmpty()) {
        splitCommand(configured)
      } else {
        /*
         * `npx --yes` by default, so a fresh install needs no configuration at all.
         *
         * `--yes` is not optional: without it npx prompts before fetching a package it does not
         * have, and a prompt nobody can see is a process that hangs for ever. It also serves the
         * latest rather than whatever a stale cache holds, which this project has already been
         * caught by once.
         */
        listOf(npxExecutable(), "--yes", "@chosengeneration/light-code@latest")
      }

    if (parts.isEmpty()) throw IllegalStateException("The configured command is empty.")

    val line = GeneralCommandLine(parts)
    line.addParameters("--workspace", root)
    line.addParameters("--print-url")
    /*
     * `--no-token` and loopback.
     *
     * The panel cannot carry a one-time launch fragment through a URL it is handed programmatically
     * without the token being in this process's memory anyway, and the server still checks Origin
     * and Host — so a page in a browser on this machine cannot reach it. What it does mean is that
     * any *program* running as this user can, which is the same trade the CLI documents for a
     * machine you trust. It is a setting, so somebody who does not accept that can turn it off.
     */
    if (settings.state.noToken) line.addParameter("--no-token")
    settings.state.extraArguments.split(' ').map { it.trim() }.filter { it.isNotEmpty() }.forEach {
      line.addParameter(it)
    }

    line.setWorkDirectory(File(root))
    line.charset = Charsets.UTF_8
    return line
  }

  /**
   * `npx` is a shell script on Windows, and Java will not run one directly.
   *
   * The same trap CLAUDE.md records for `uv`, `npx` and `pnpm` in the extension: they are `.cmd`
   * shims, and a bare name resolves to something the process API cannot execute.
   */
  private fun npxExecutable(): String = if (SystemInfo.isWindows) "npx.cmd" else "npx"

  /** Splits a configured command on spaces, respecting double quotes around a path. */
  private fun splitCommand(value: String): List<String> {
    val parts = mutableListOf<String>()
    val current = StringBuilder()
    var quoted = false
    for (character in value) {
      when {
        character == '"' -> quoted = !quoted
        character == ' ' && !quoted -> {
          if (current.isNotEmpty()) {
            parts.add(current.toString())
            current.clear()
          }
        }
        else -> current.append(character)
      }
    }
    if (current.isNotEmpty()) parts.add(current.toString())
    return parts
  }

  /** Stops the server, so closing the project does not leave one listening. */
  @Synchronized
  fun stop() {
    handler?.let { process ->
      /*
       * The whole tree, not the one process.
       *
       * `npx` spawns node, and node spawns MCP servers and a Python worker. Killing only the
       * parent leaves every one of those running — the same reason the extension's terminal uses
       * `taskkill /T` rather than `child.kill()`.
       */
      process.destroyProcess()
      process.waitFor(5_000)
    }
    handler = null
    started = null
  }

  override fun dispose() = stop()
}
