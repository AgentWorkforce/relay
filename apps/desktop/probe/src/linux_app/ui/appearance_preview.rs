//! Small window preview used by the appearance settings.

use gtk::prelude::*;
use gtk4 as gtk;

/// A tiny drawing of the window: rail, sidebar and content.
pub(super) fn mini_window(dark: bool) -> gtk::DrawingArea {
    let area = gtk::DrawingArea::new();
    area.set_content_height(74);
    area.set_hexpand(true);
    area.set_draw_func(move |_, context, width, height| {
        let (width, height) = (width as f64, height as f64);
        let (base, panel, line) = if dark {
            (0.14, 0.2, 0.32)
        } else {
            (0.97, 0.91, 0.8)
        };
        let fill = |red: f64, green: f64, blue: f64, alpha: f64, x: f64, y: f64, w: f64, h: f64| {
            context.set_source_rgba(red, green, blue, alpha);
            context.rectangle(x, y, w, h);
            let _ = context.fill();
        };
        fill(base, base, base, 1.0, 0.0, 0.0, width, height);
        fill(panel, panel, panel, 1.0, 0.0, 0.0, 12.0, height);
        fill(panel, panel, panel, 0.6, 12.0, 0.0, 34.0, height);
        fill(0.23, 0.51, 0.96, 0.7, 18.0, 6.0, 22.0, 5.0);
        for (y, w) in [(15.0, 18.0), (23.0, 20.0)] {
            fill(line, line, line, 1.0, 18.0, y, w, 4.0);
        }
        fill(
            line,
            line,
            line,
            1.0,
            52.0,
            6.0,
            (width - 58.0).max(10.0),
            5.0,
        );
        for y in [15.0, 33.0] {
            fill(
                panel,
                panel,
                panel,
                1.0,
                52.0,
                y,
                (width - 58.0).max(10.0),
                14.0,
            );
        }
    });
    area
}
