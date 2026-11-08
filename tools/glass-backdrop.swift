// Writes a frosted copy of a picture (the desktop wallpaper) for omp-chat's glass backdrop.
//   swift tools/glass-backdrop.swift <in> <out.jpg>
// Herdr can't blur what is behind its window, so the layout paints this behind its translucent panels.
import CoreImage
import Foundation
import ImageIO
import UniformTypeIdentifiers

let args = CommandLine.arguments
guard args.count == 3, let source = CIImage(contentsOf: URL(fileURLWithPath: args[1])) else {
  FileHandle.standardError.write("usage: glass-backdrop.swift <picture> <out.jpg>\n".data(using: .utf8)!)
  exit(1)
}
// Blurring a 1600px copy looks the same as the full picture and takes a fraction of the time.
let scale = min(1, 1600 / max(source.extent.width, source.extent.height))
let small = source.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
let frosted = small.clampedToExtent()
  .applyingGaussianBlur(sigma: 60)
  .applyingFilter("CIColorControls", parameters: [kCIInputSaturationKey: 1.6, kCIInputBrightnessKey: -0.04])
  .cropped(to: small.extent)
let context = CIContext()
guard let cg = context.createCGImage(frosted, from: frosted.extent),
      let out = CGImageDestinationCreateWithURL(URL(fileURLWithPath: args[2]) as CFURL, UTType.jpeg.identifier as CFString, 1, nil)
else { exit(1) }
CGImageDestinationAddImage(out, cg, [kCGImageDestinationLossyCompressionQuality: 0.9] as CFDictionary)
exit(CGImageDestinationFinalize(out) ? 0 : 1)
