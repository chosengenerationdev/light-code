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

intellijPlatform {
  pluginConfiguration {
    ideaVersion {
      sinceBuild = providers.gradleProperty("pluginSinceBuild")
      untilBuild = providers.gradleProperty("pluginUntilBuild")
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
