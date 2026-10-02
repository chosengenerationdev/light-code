plugins {
  id("java")
  id("org.jetbrains.kotlin.jvm") version "1.9.25"
  id("org.jetbrains.intellij.platform") version "2.1.0"
}

group = providers.gradleProperty("pluginGroup").get()
version = providers.gradleProperty("pluginVersion").get()

repositories {
  mavenCentral()
  intellijPlatform { defaultRepositories() }
}

dependencies {
  intellijPlatform {
    create(
      providers.gradleProperty("platformType").get(),
      providers.gradleProperty("platformVersion").get(),
    )
    instrumentationTools()
  }
}

kotlin { jvmToolchain(17) }

/*
 * The Light Code this plugin runs, packed inside it.
 *
 * The plugin is a panel and a launcher; everything Light Code does is the Node host. Packing the
 * host built from the same commit is what makes every enhancement and fix in the VS Code extension
 * and the Node package reach IntelliJ and PyCharm in the same release, instead of whenever npm
 * happens to be updated. Build the host first: `pnpm --filter @chosengeneration/light-code run build`.
 */
val bundledHost = layout.projectDirectory.file("../host/dist/cli.cjs")

tasks.named<org.jetbrains.intellij.platform.gradle.tasks.PrepareSandboxTask>("prepareSandbox") {
  doFirst {
    require(bundledHost.asFile.isFile) {
      "apps/host/dist/cli.cjs is missing. Build the Node host first (pnpm --filter @chosengeneration/light-code run build): " +
        "the plugin packs it so IntelliJ and PyCharm run the same Light Code as the other packages."
    }
  }
  from(bundledHost) {
    into(intellijPlatform.projectName.map { "$it/host" })
    rename { "light-code.cjs" }
  }
}

intellijPlatform {
  pluginConfiguration {
    ideaVersion {
      sinceBuild = providers.gradleProperty("pluginSinceBuild")
      /*
       * No upper bound. A fixed until-build makes every IDE released after it refuse the plugin —
       * 251.* (2025.1) did exactly that to every later IntelliJ and PyCharm. The plugin uses only
       * the tool window, JCEF and process APIs, which are stable across releases.
       */
      untilBuild = provider { null }
    }
  }

  /*
   * Signing and publishing read from the environment, never from a file in the repository.
   *
   * The same rule the rest of this project follows for credentials: a token in a checked-in
   * properties file is a token in everybody's clone and in the history for ever. JetBrains
   * requires plugins to be signed, so the certificate chain and private key come the same way.
   */
  signing {
    certificateChain = providers.environmentVariable("JETBRAINS_CERTIFICATE_CHAIN")
    privateKey = providers.environmentVariable("JETBRAINS_PRIVATE_KEY")
    password = providers.environmentVariable("JETBRAINS_PRIVATE_KEY_PASSWORD")
  }

  publishing { token = providers.environmentVariable("JETBRAINS_MARKETPLACE_TOKEN") }
}
