import AppKit

let output = CommandLine.arguments[1]
let size = 1024
let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
let body = NSBezierPath(roundedRect: NSRect(x: 42, y: 42, width: 940, height: 940), xRadius: 210, yRadius: 210)
let shadow = NSShadow(); shadow.shadowColor = NSColor.black.withAlphaComponent(0.28); shadow.shadowBlurRadius = 28; shadow.shadowOffset = NSSize(width: 0, height: -8); shadow.set()
NSGradient(starting: NSColor(srgbRed: 0.10, green: 0.21, blue: 0.28, alpha: 1), ending: NSColor(srgbRed: 0.025, green: 0.06, blue: 0.10, alpha: 1))!.draw(in: body, angle: -75)
NSShadow().set()
NSColor(srgbRed: 0.8, green: 0.94, blue: 1, alpha: 0.2).setStroke(); body.lineWidth = 2; body.stroke()
let center = CGPoint(x: 512, y: 525)
for radius in [345.0, 377.0] {
    let circle = NSBezierPath(ovalIn: CGRect(x: center.x-radius, y: center.y-radius, width: radius*2, height: radius*2))
    NSColor(srgbRed: 0.62, green: 0.88, blue: 0.97, alpha: radius == 345 ? 0.13 : 0.06).setStroke(); circle.lineWidth = 1.8; circle.stroke()
}
let count = 1800
let golden = Double.pi * (3 - sqrt(5.0))
struct Dot { let x: Double; let y: Double; let z: Double }
var dots: [Dot] = []
for index in 0..<count {
    let y = 1 - Double(index) / Double(count - 1) * 2
    let r = sqrt(1-y*y); let theta = golden * Double(index)
    let x = cos(theta)*r; let z = sin(theta)*r
    let rotatedX = x*cos(0.25)+z*sin(0.25); let rotatedZ = -x*sin(0.25)+z*cos(0.25)
    dots.append(Dot(x: rotatedX, y: y, z: rotatedZ))
}
for dot in dots.sorted(by: {$0.z < $1.z}) {
    let depth = (dot.z+1)/2; let scale = 285*(0.95+depth*0.05)
    let radius = 1.25+depth*1.65
    NSColor(srgbRed: 0.72+depth*0.18, green: 0.91+depth*0.06, blue: 1, alpha: 0.12+depth*0.72).setFill()
    NSBezierPath(ovalIn: CGRect(x: center.x+dot.x*scale-radius, y: center.y+dot.y*scale-radius, width: radius*2, height: radius*2)).fill()
}
let glow = NSShadow(); glow.shadowColor = NSColor(srgbRed: 0.5, green: 0.9, blue: 1, alpha: 0.65); glow.shadowBlurRadius = 13; glow.set()
NSColor(srgbRed: 0.68, green: 0.95, blue: 1, alpha: 1).setFill(); NSBezierPath(ovalIn: CGRect(x: 507, y: 158, width: 10, height: 10)).fill()
NSGraphicsContext.restoreGraphicsState()
try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: output))
