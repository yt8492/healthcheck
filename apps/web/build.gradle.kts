import org.jetbrains.kotlin.gradle.targets.js.webpack.KotlinWebpackConfig

plugins {
    kotlin("multiplatform") version "2.4.21"
    kotlin("plugin.serialization") version "2.4.21"
    id("org.jetbrains.kotlin.plugin.compose") version "2.4.21"
    id("org.jetbrains.compose") version "1.12.2"
}

@OptIn(org.jetbrains.kotlin.gradle.ExperimentalWasmDsl::class)
kotlin {
    wasmJs {
        outputModuleName.set("healthcheck")
        browser {
            commonWebpackConfig {
                outputFileName = "healthcheck.js"
                devServer = (devServer ?: KotlinWebpackConfig.DevServer()).apply {
                    port = 5173
                    open = false
                }
            }
            testTask {
                useKarma { useChromeHeadless() }
            }
        }
        binaries.executable()
    }
    sourceSets {
        commonMain.dependencies {
            implementation("org.jetbrains.compose.runtime:runtime:1.12.2")
            implementation("org.jetbrains.compose.foundation:foundation:1.12.2")
            implementation("org.jetbrains.compose.ui:ui:1.12.2")
            implementation("org.jetbrains.compose.components:components-resources:1.12.2")
            implementation("org.jetbrains.compose.material3:material3:1.9.0")
            implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.10.2")
            implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.13.0")
            implementation("org.jetbrains.kotlinx:kotlinx-datetime:0.8.0")
            implementation("io.ktor:ktor-client-core:3.6.1")
        }
        wasmJsMain {
            resources.srcDir("public")
            dependencies {
                implementation("io.ktor:ktor-client-js:3.6.1")
            }
        }
        commonTest.dependencies {
            implementation(kotlin("test"))
            implementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.2")
            implementation("io.ktor:ktor-client-mock:3.6.1")
        }
    }
}

compose.resources {
    packageOfResClass = "healthcheck.resources"
}
