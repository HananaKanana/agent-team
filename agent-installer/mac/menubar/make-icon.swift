// 画 ateam.app 的图标（1024×1024 PNG）：圆角方块 + 白色的三人图标。用法：make-icon <输出.png>
import AppKit

let size: CGFloat = 1024
let image = NSImage(size: NSSize(width: size, height: size), flipped: false) { rect in
    let inset = rect.insetBy(dx: 100, dy: 100)
    let path = NSBezierPath(roundedRect: inset, xRadius: 185, yRadius: 185)
    NSGradient(starting: NSColor(red: 0.20, green: 0.42, blue: 0.72, alpha: 1), ending: NSColor(red: 0.13, green: 0.30, blue: 0.55, alpha: 1))?.draw(in: path, angle: -90)
    if let s = NSImage(systemSymbolName: "person.3.fill", accessibilityDescription: nil)?.withSymbolConfiguration(.init(pointSize: 330, weight: .medium)) {
        let w = s.size.width, h = s.size.height
        let r = NSRect(x: (size - w) / 2, y: (size - h) / 2, width: w, height: h)
        let white = NSImage(size: s.size, flipped: false) { tr in
            s.draw(in: tr)
            NSColor.white.set()
            tr.fill(using: .sourceAtop)
            return true
        }
        white.draw(in: r)
    }
    return true
}
guard let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff), let png = rep.representation(using: .png, properties: [:]) else { exit(1) }
try png.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
