import Foundation

// Apple Foundation Models helper — protocol v2.
// macOS 26 SDK-safe: only uses FoundationModels APIs available since macOS 26.0.
// Newer capabilities (image attachments, token counting, context size) live in
// apple-foundation-models-helper-27.swift, which requires the macOS 27 SDK.
//
// Input:  one JSON object on stdin.
//   { "command": "respond", "prompt": "...", "instructions": "...",
//     "useCase": "general|contentTagging",
//     "options": { "temperature": 0.2, "maximumResponseTokens": 512, "sampling": "greedy" },
//     "stream": true }
//   { "command": "capabilities" }
//
// Output: newline-delimited JSON events on stdout.
//   {"type":"delta","text":"..."}   (only when stream is true)
//   {"type":"final","ok":true,"content":"...","unavailable":false,"error":null}
//   capabilities replies with a single {"type":"capabilities",...} line.

struct HelperInput: Decodable {
  let command: String?
  let prompt: String?
  let instructions: String?
  let useCase: String?
  let options: GenerationOptionsInput?
  let stream: Bool?
}

struct GenerationOptionsInput: Decodable {
  let temperature: Double?
  let maximumResponseTokens: Int?
  let sampling: String?
}

struct FinalOutput: Encodable {
  let type = "final"
  let ok: Bool
  let content: String?
  let unavailable: Bool
  let error: String?
}

struct DeltaOutput: Encodable {
  let type = "delta"
  let text: String
}

struct CapabilitiesOutput: Encodable {
  let type = "capabilities"
  let ok: Bool
  let available: Bool
  let reason: String
  let features: FeatureFlags
  let implementation: String
}

struct FeatureFlags: Encodable {
  let streaming: Bool
  let instructions: Bool
  let images: Bool
  let tokenCounting: Bool
  let contextSize: Bool
  let useCases: Bool
  let structuredOutput: Bool
}

func emit<T: Encodable>(_ value: T) {
  let encoder = JSONEncoder()
  guard let data = try? encoder.encode(value), let text = String(data: data, encoding: .utf8) else {
    print("{\"type\":\"final\",\"ok\":false,\"unavailable\":false,\"error\":\"Failed to encode helper output\"}")
    return
  }
  print(text)
  fflush(stdout)
}

func emitFinal(ok: Bool, content: String? = nil, unavailable: Bool = false, error: String? = nil) {
  emit(FinalOutput(ok: ok, content: content, unavailable: unavailable, error: error))
}

func readInput() throws -> HelperInput {
  let data = FileHandle.standardInput.readDataToEndOfFile()
  return try JSONDecoder().decode(HelperInput.self, from: data)
}

#if canImport(FoundationModels)
import FoundationModels

@available(macOS 26.0, *)
func resolveUseCase(_ useCase: String?) -> SystemLanguageModel {
  switch useCase {
  case "contentTagging", "content-tagging":
    return SystemLanguageModel(useCase: .contentTagging)
  default:
    return SystemLanguageModel.default
  }
}

@available(macOS 26.0, *)
func availabilityReason(_ model: SystemLanguageModel) -> String {
  switch model.availability {
  case .available:
    return "available"
  case .unavailable(let reason):
    switch reason {
    case .deviceNotEligible:
      return "deviceNotEligible"
    case .appleIntelligenceNotEnabled:
      return "appleIntelligenceNotEnabled"
    case .modelNotReady:
      return "modelNotReady"
    default:
      return String(describing: reason)
    }
  }
}

@available(macOS 26.0, *)
func emitCapabilities() {
  let model = SystemLanguageModel.default
  let reason = availabilityReason(model)
  emit(
    CapabilitiesOutput(
      ok: true,
      available: reason == "available",
      reason: reason,
      features: FeatureFlags(
        streaming: true,
        instructions: true,
        images: false,
        tokenCounting: false,
        contextSize: false,
        useCases: true,
        structuredOutput: false
      ),
      implementation: "swift-helper-v2"
    )
  )
}

@available(macOS 26.0, *)
func resolveGenerationOptions(_ input: GenerationOptionsInput?) -> GenerationOptions {
  guard let input else { return GenerationOptions() }
  let sampling: GenerationOptions.SamplingMode? =
    input.sampling == "greedy" ? .greedy : nil
  return GenerationOptions(
    samplingMode: sampling,
    temperature: input.temperature,
    maximumResponseTokens: input.maximumResponseTokens
  )
}

@available(macOS 26.0, *)
func runFoundationModel(input: HelperInput) async {
  let model = resolveUseCase(input.useCase)
  let reason = availabilityReason(model)
  guard reason == "available" else {
    emitFinal(
      ok: false,
      unavailable: true,
      error:
        "Apple Foundation Models are not available on this Mac (\(reason))."
    )
    return
  }

  guard let prompt = input.prompt, !prompt.isEmpty else {
    emitFinal(ok: false, error: "Missing prompt")
    return
  }

  do {
    let session = LanguageModelSession(
      model: model,
      instructions: input.instructions ?? ""
    )
    let options = resolveGenerationOptions(input.options)

    if input.stream == true {
      var emitted = ""
      let stream = session.streamResponse(to: prompt, options: options)
      for try await snapshot in stream {
        let content = snapshot.content
        if content.count > emitted.count {
          let delta = String(content.dropFirst(emitted.count))
          emitted = content
          emit(DeltaOutput(text: delta))
        }
      }
      emitFinal(ok: true, content: emitted)
    } else {
      let response = try await session.respond(to: prompt, options: options)
      emitFinal(ok: true, content: response.content)
    }
  } catch {
    emitFinal(ok: false, error: String(describing: error))
  }
}
#endif

do {
  let input = try readInput()

  #if canImport(FoundationModels)
  if #available(macOS 26.0, *) {
    if input.command == "capabilities" {
      emitCapabilities()
    } else {
      let semaphore = DispatchSemaphore(value: 0)
      Task {
        await runFoundationModel(input: input)
        semaphore.signal()
      }
      semaphore.wait()
    }
  } else {
    emitFinal(
      ok: false,
      unavailable: true,
      error: "Apple Foundation Models require macOS 26 or later."
    )
  }
  #else
  emitFinal(
    ok: false,
    unavailable: true,
    error: "FoundationModels is not available in the installed Swift toolchain."
  )
  #endif
} catch {
  emitFinal(ok: false, error: String(describing: error))
}
