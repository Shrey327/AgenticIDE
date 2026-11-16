import Foundation
import Vision

do {
    guard CommandLine.arguments.count == 2 else { throw NSError(domain: "OCR", code: 1) }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["en-US"]
    request.usesLanguageCorrection = false
    try VNImageRequestHandler(url: URL(fileURLWithPath: CommandLine.arguments[1])).perform([request])
    let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
    let data = try JSONSerialization.data(withJSONObject: ["text": lines.joined(separator: "\n")])
    print(String(data: data, encoding: .utf8)!)
} catch {
    FileHandle.standardError.write(Data("Local Vision OCR failed: \(error)".utf8))
    exit(1)
}
