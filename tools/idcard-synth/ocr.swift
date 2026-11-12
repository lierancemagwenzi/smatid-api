// Reads the text on pictures with Apple's Vision framework (macOS), line by line with boxes, in the
// same shape the Smatid SDK sends from the phone (ML Kit): {"lines": [{"text", "box": [left, top, w, h]}]}
// with boxes as fractions of the picture, top-left origin.
//
//   swift tools/idcard-synth/ocr.swift <dir with labels.jsonl>
//
// Writes <dir>/ocr.jsonl: {"image": "...", "ocr": {"lines": [...]}} per picture in labels.jsonl.
import Foundation
import Vision
import AppKit

guard CommandLine.arguments.count == 2 else {
    FileHandle.standardError.write("usage: swift ocr.swift <dir>\n".data(using: .utf8)!)
    exit(2)
}
let dir = URL(fileURLWithPath: CommandLine.arguments[1])
let labels = try String(contentsOf: dir.appendingPathComponent("labels.jsonl"), encoding: .utf8)
let out = dir.appendingPathComponent("ocr.jsonl")
FileManager.default.createFile(atPath: out.path, contents: nil)
let handle = try FileHandle(forWritingTo: out)

func read(_ url: URL) throws -> [[String: Any]] {
    guard let image = NSImage(contentsOf: url),
          let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return [] }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false
    request.recognitionLanguages = ["en-US"]
    try VNImageRequestHandler(cgImage: cg, options: [:]).perform([request])
    var lines: [[String: Any]] = []
    for obs in request.results ?? [] {
        guard let text = obs.topCandidates(1).first?.string, !text.trimmingCharacters(in: .whitespaces).isEmpty else { continue }
        let b = obs.boundingBox  // normalised, bottom-left origin
        let r = { (v: CGFloat) in (Double(v) * 10000).rounded() / 10000 }
        lines.append(["text": text, "box": [r(b.minX), r(1 - b.maxY), r(b.width), r(b.height)]])
    }
    return lines
}

var count = 0
for row in labels.split(separator: "\n") where !row.isEmpty {
    guard let json = try JSONSerialization.jsonObject(with: Data(row.utf8)) as? [String: Any],
          let image = json["image"] as? String else { continue }
    let lines = try read(dir.appendingPathComponent(image))
    let record: [String: Any] = ["image": image, "ocr": ["lines": lines]]
    handle.write(try JSONSerialization.data(withJSONObject: record))
    handle.write("\n".data(using: .utf8)!)
    count += 1
    if count % 50 == 0 { print("read \(count)") }
}
try handle.close()
print("Read \(count) pictures into \(out.path)")
