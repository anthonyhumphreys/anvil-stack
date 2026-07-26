import AVFoundation
import AppKit
import Foundation
import Speech

let helperArguments = Array(CommandLine.arguments.dropFirst())
let eventFilePath = helperArguments.first
let stopFilePath = helperArguments.dropFirst().first
let eventFileLock = NSLock()

struct HelperEvent: Encodable {
  let type: String
  let text: String?
  let isFinal: Bool?
  let error: String?
}

func emit(type: String, text: String? = nil, isFinal: Bool? = nil, error: String? = nil) {
  let event = HelperEvent(type: type, text: text, isFinal: isFinal, error: error)
  let encoder = JSONEncoder()

  guard
    let data = try? encoder.encode(event),
    let line = String(data: data, encoding: .utf8)
  else {
    print("{\"type\":\"error\",\"error\":\"Failed to encode speech helper output\"}")
    fflush(stdout)
    return
  }

  if let eventFilePath {
    eventFileLock.lock()
    defer { eventFileLock.unlock() }

    if let file = FileHandle(forWritingAtPath: eventFilePath) {
      file.seekToEndOfFile()
      if let output = "\(line)\n".data(using: .utf8) {
        file.write(output)
        try? file.synchronize()
      }
      try? file.close()
    }
  }

  print(line)
  fflush(stdout)
}

final class SpeechSession {
  private let audioEngine = AVAudioEngine()
  private let recognitionRequest = SFSpeechAudioBufferRecognitionRequest()
  private var recognitionTask: SFSpeechRecognitionTask?
  private var stopFallback: DispatchWorkItem?
  private var isStopping = false

  func start() {
    guard let recognizer = SFSpeechRecognizer(locale: Locale.current) else {
      emit(type: "error", error: "Speech recognition is not available for the current language.")
      exit(1)
    }

    guard recognizer.isAvailable else {
      emit(type: "error", error: "Apple speech recognition is currently unavailable.")
      exit(1)
    }

    recognitionRequest.shouldReportPartialResults = true

    if #available(macOS 13.0, *), recognizer.supportsOnDeviceRecognition {
      recognitionRequest.requiresOnDeviceRecognition = true
    }

    recognitionTask = recognizer.recognitionTask(with: recognitionRequest) {
      [weak self] result, error in
      guard let self else { return }

      if let result {
        emit(
          type: "result",
          text: result.bestTranscription.formattedString,
          isFinal: result.isFinal
        )

        if result.isFinal {
          self.finish()
          return
        }
      }

      if let error, !self.isStopping {
        emit(type: "error", error: error.localizedDescription)
        self.finish(exitCode: 1)
      }
    }

    let inputNode = audioEngine.inputNode
    let format = inputNode.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0 else {
      emit(type: "error", error: "The selected microphone did not provide a usable audio format.")
      finish(exitCode: 1)
      return
    }

    inputNode.installTap(onBus: 0, bufferSize: 1_024, format: format) {
      [weak self] buffer, _ in
      self?.recognitionRequest.append(buffer)
    }

    do {
      audioEngine.prepare()
      try audioEngine.start()
      emit(type: "status", text: "listening")
    } catch {
      inputNode.removeTap(onBus: 0)
      emit(type: "error", error: "Could not start microphone capture: \(error.localizedDescription)")
      finish(exitCode: 1)
    }
  }

  func stop() {
    guard !isStopping else { return }
    isStopping = true

    if audioEngine.isRunning {
      audioEngine.stop()
      audioEngine.inputNode.removeTap(onBus: 0)
    }
    recognitionRequest.endAudio()

    let fallback = DispatchWorkItem { [weak self] in
      self?.finish()
    }
    stopFallback = fallback
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.0, execute: fallback)
  }

  private func finish(exitCode: Int32 = 0) {
    stopFallback?.cancel()
    stopFallback = nil

    if audioEngine.isRunning {
      audioEngine.stop()
      audioEngine.inputNode.removeTap(onBus: 0)
    }
    recognitionTask?.cancel()
    recognitionTask = nil

    emit(type: "status", text: "stopped")
    exit(exitCode)
  }
}

let session = SpeechSession()

let stopFileTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { timer in
  guard let stopFilePath, FileManager.default.fileExists(atPath: stopFilePath) else { return }
  timer.invalidate()
  session.stop()
}

signal(SIGTERM, SIG_IGN)
signal(SIGINT, SIG_IGN)

let terminationSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
terminationSource.setEventHandler {
  session.stop()
}
terminationSource.resume()

let interruptSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
interruptSource.setEventHandler {
  session.stop()
}
interruptSource.resume()

let helperApplication = NSApplication.shared
helperApplication.setActivationPolicy(.accessory)
helperApplication.activate(ignoringOtherApps: true)

func requestMicrophoneAndStart() {
  emit(type: "status", text: "requesting-microphone")
  AVCaptureDevice.requestAccess(for: .audio) { granted in
    DispatchQueue.main.async {
      if granted {
        session.start()
      } else {
        emit(
          type: "error",
          error: "Microphone access is off for Anvil Speech Recognition. Enable it in System Settings → Privacy & Security → Microphone."
        )
        exit(1)
      }
    }
  }
}

func handleSpeechAuthorization(_ status: SFSpeechRecognizerAuthorizationStatus) {
  switch status {
  case .authorized:
    requestMicrophoneAndStart()
  case .denied:
    emit(
      type: "error",
      error: "Speech recognition access is off for Anvil. Enable it in System Settings → Privacy & Security → Speech Recognition."
    )
    exit(1)
  case .restricted:
    emit(type: "error", error: "Speech recognition access is restricted by macOS.")
    exit(1)
  case .notDetermined:
    emit(type: "error", error: "Speech recognition permission was not granted.")
    exit(1)
  @unknown default:
    emit(type: "error", error: "macOS returned an unknown speech recognition permission state.")
    exit(1)
  }
}

let currentSpeechAuthorization = SFSpeechRecognizer.authorizationStatus()
if currentSpeechAuthorization == .authorized {
  requestMicrophoneAndStart()
} else {
  emit(type: "status", text: "authorizing")
  SFSpeechRecognizer.requestAuthorization { status in
    DispatchQueue.main.async {
      handleSpeechAuthorization(status)
    }
  }
}

helperApplication.run()
