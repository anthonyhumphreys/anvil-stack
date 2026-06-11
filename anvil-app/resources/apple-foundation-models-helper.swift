import Foundation

struct HelperInput: Decodable {
  let prompt: String
}

struct HelperOutput: Encodable {
  let ok: Bool
  let content: String?
  let unavailable: Bool
  let error: String?
}

func emit(_ output: HelperOutput) {
  let encoder = JSONEncoder()
  guard let data = try? encoder.encode(output), let text = String(data: data, encoding: .utf8) else {
    print("{\"ok\":false,\"unavailable\":false,\"error\":\"Failed to encode helper output\"}")
    return
  }
  print(text)
}

func readInput() throws -> HelperInput {
  let data = FileHandle.standardInput.readDataToEndOfFile()
  return try JSONDecoder().decode(HelperInput.self, from: data)
}

#if canImport(FoundationModels)
import FoundationModels

@available(macOS 26.0, *)
func runFoundationModel(prompt: String) async {
  let model = SystemLanguageModel.default

  switch model.availability {
  case .available:
    break
  default:
    emit(
      HelperOutput(
        ok: false,
        content: nil,
        unavailable: true,
        error: "Apple Foundation Models are not available on this Mac or Apple Intelligence is disabled."
      )
    )
    return
  }

  do {
    let session = LanguageModelSession(model: model)
    let response = try await session.respond(to: prompt)
    emit(HelperOutput(ok: true, content: response.content, unavailable: false, error: nil))
  } catch {
    emit(HelperOutput(ok: false, content: nil, unavailable: false, error: String(describing: error)))
  }
}
#endif

do {
  let input = try readInput()

  #if canImport(FoundationModels)
  if #available(macOS 26.0, *) {
    let semaphore = DispatchSemaphore(value: 0)
    Task {
      await runFoundationModel(prompt: input.prompt)
      semaphore.signal()
    }
    semaphore.wait()
  } else {
    emit(
      HelperOutput(
        ok: false,
        content: nil,
        unavailable: true,
        error: "Apple Foundation Models require macOS 26 or later."
      )
    )
  }
  #else
  emit(
    HelperOutput(
      ok: false,
      content: nil,
      unavailable: true,
      error: "FoundationModels is not available in the installed Swift toolchain."
    )
  )
  #endif
} catch {
  emit(HelperOutput(ok: false, content: nil, unavailable: false, error: String(describing: error)))
}
