//! Small GTK building blocks the pages share, so every region reads as one
//! control surface: the Mac's sidebar rows, section headers, banners,
//! settings rows, avatars and presence dots.

use super::theme::Palette;
use crate::linux_app::models::{initials, source_name, Presence};
use gtk::{gdk, gdk_pixbuf, glib, prelude::*, subclass::prelude::*};
use gtk4 as gtk;
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::time::Duration;

#[path = "widgets/assets.rs"]
pub mod art;

/// Single-color marks drawn in the text color, as the Mac's template images
/// are.
const TEMPLATE_MARKS: [&str; 6] = ["grok", "cursor", "opencode", "openai", "muse", "devin"];

/// A picture by name, size and the tint a template mark is drawn in.
type RasterKey = (String, i32, i32, String);

/// What a button or menu item runs.
pub type Callback = Box<dyn Fn()>;

thread_local! {
    static AVATARS: RefCell<HashMap<String, gdk::Texture>> = RefCell::default();
    static RASTERS: RefCell<HashMap<RasterKey, Option<gdk::Texture>>> = RefCell::default();
    /// The drawn theme's colors, set by the theme; template marks and
    /// glyphs are drawn in them.
    static PALETTE: Cell<&'static Palette> = const { Cell::new(&super::theme::LIGHT) };
}

/// Pictures are drawn in `palette`'s colors from now on.
pub fn set_palette(palette: &'static Palette) {
    PALETTE.with(|current| current.set(palette));
}

/// The drawn theme's color `name` (`#rrggbb`).
pub fn color(name: &str) -> &'static str {
    PALETTE.with(|palette| {
        palette
            .get()
            .0
            .iter()
            .find(|(key, _)| *key == name)
            .map_or("#808080", |(_, value)| *value)
    })
}

pub fn add_classes(widget: &impl IsA<gtk::Widget>, classes: &[&str]) {
    for class in classes.iter().filter(|class| !class.is_empty()) {
        widget.add_css_class(class);
    }
}

pub fn toggle_class(widget: &impl IsA<gtk::Widget>, class: &str, on: bool) {
    if on {
        widget.add_css_class(class);
    } else {
        widget.remove_css_class(class);
    }
}

pub fn hbox(spacing: i32, classes: &[&str]) -> gtk::Box {
    let widget = gtk::Box::new(gtk::Orientation::Horizontal, spacing);
    add_classes(&widget, classes);
    widget
}

pub fn vbox(spacing: i32, classes: &[&str]) -> gtk::Box {
    let widget = gtk::Box::new(gtk::Orientation::Vertical, spacing);
    add_classes(&widget, classes);
    widget
}

/// Margins: `top`, then `end`, `bottom` and `start` defaulting as CSS does.
pub fn pad(widget: &impl IsA<gtk::Widget>, top: i32, end: Option<i32>, bottom: Option<i32>) {
    let end = end.unwrap_or(top);
    let bottom = bottom.unwrap_or(top);
    widget.set_margin_top(top);
    widget.set_margin_end(end);
    widget.set_margin_bottom(bottom);
    widget.set_margin_start(end);
}

/// A label, left-aligned.
pub fn text(value: &str, classes: &[&str]) -> gtk::Label {
    let label = gtk::Label::new(Some(value));
    label.set_xalign(0.0);
    add_classes(&label, classes);
    label
}

/// Label options, chained.
pub trait LabelStyle {
    fn wrapped(self) -> Self;
    fn centered(self) -> Self;
    fn ellipsized(self) -> Self;
    fn copyable(self) -> Self;
}

impl LabelStyle for gtk::Label {
    fn wrapped(self) -> Self {
        self.set_wrap(true);
        self.set_wrap_mode(gtk::pango::WrapMode::WordChar);
        self
    }

    fn centered(self) -> Self {
        self.set_xalign(0.5);
        self.set_justify(gtk::Justification::Center);
        self
    }

    fn ellipsized(self) -> Self {
        self.set_ellipsize(gtk::pango::EllipsizeMode::End);
        self.set_tooltip_text(Some(&self.text()));
        self
    }

    fn copyable(self) -> Self {
        self.set_selectable(true);
        self
    }
}

pub fn icon(name: &str, size: i32) -> gtk::Image {
    let image = gtk::Image::from_icon_name(name);
    image.set_pixel_size(size);
    image
}

extern "C" {
    /// GTK 4.0 API; gtk4-rs binds it only for GTK 4.10 and later.
    fn gtk_accessible_update_property_value(
        accessible: *mut gtk::ffi::GtkWidget,
        n_properties: std::ffi::c_int,
        properties: *mut gtk::ffi::GtkAccessibleProperty,
        values: *const glib::gobject_ffi::GValue,
    );
}

/// Names `widget` for assistive technology.
pub fn name(widget: &impl IsA<gtk::Widget>, value: &str) {
    use glib::translate::ToGlibPtr;
    let mut properties = [gtk::ffi::GTK_ACCESSIBLE_PROPERTY_LABEL];
    let value = value.to_value();
    // SAFETY: every widget is a `GtkAccessible`; one property and one value,
    // the label as the string GValue it takes.
    unsafe {
        gtk_accessible_update_property_value(
            widget.as_ref().to_glib_none().0,
            1,
            properties.as_mut_ptr(),
            value.to_glib_none().0,
        );
    }
}

/// Action controls use a pointer only while sensitive, including when a parent
/// becomes insensitive. State changes update the cursor under a stationary pointer.
pub fn action_cursor(widget: &impl IsA<gtk::Widget>) {
    fn update(widget: &gtk::Widget) {
        widget.set_cursor_from_name(Some(if widget.is_sensitive() {
            "pointer"
        } else {
            "default"
        }));
    }
    let widget = widget.as_ref();
    update(widget);
    widget.connect_state_flags_changed(|widget, _| update(widget));
}

/// A button showing `label`.
pub fn button(label: &str, classes: &[&str], on: impl Fn() + 'static) -> gtk::Button {
    let widget = gtk::Button::with_label(label);
    action_cursor(&widget);
    add_classes(&widget, classes);
    widget.connect_clicked(move |_| on());
    widget
}

/// A button showing an icon, named by `tooltip`.
pub fn icon_button(
    icon_name: &str,
    tooltip: &str,
    classes: &[&str],
    on: impl Fn() + 'static,
) -> gtk::Button {
    let widget = gtk::Button::new();
    action_cursor(&widget);
    widget.set_child(Some(&icon(icon_name, 14)));
    widget.set_tooltip_text(Some(tooltip));
    name(&widget, tooltip);
    add_classes(&widget, classes);
    widget.connect_clicked(move |_| on());
    widget
}

/// A button showing an icon beside `label`.
pub fn labeled_button(
    label: &str,
    icon_name: &str,
    classes: &[&str],
    on: impl Fn() + 'static,
) -> gtk::Button {
    let widget = gtk::Button::new();
    action_cursor(&widget);
    let content = hbox(6, &[]);
    content.append(&icon(icon_name, 14));
    content.append(&gtk::Label::new(Some(label)));
    widget.set_child(Some(&content));
    name(&widget, label);
    add_classes(&widget, classes);
    widget.connect_clicked(move |_| on());
    widget
}

/// Removes every child of `container`.
pub fn clear(container: &gtk::Box) {
    while let Some(child) = container.first_child() {
        container.remove(&child);
    }
}

/// A box that takes the remaining width, pushing what follows to the end.
pub fn spacer() -> gtk::Box {
    let widget = hbox(0, &[]);
    widget.set_hexpand(true);
    widget
}

pub fn scrolled(child: &impl IsA<gtk::Widget>) -> gtk::ScrolledWindow {
    let window = gtk::ScrolledWindow::new();
    window.set_policy(gtk::PolicyType::Never, gtk::PolicyType::Automatic);
    window.set_vexpand(true);
    window.set_child(Some(child));
    window
}

mod column_imp {
    use super::*;
    use std::cell::Cell;

    #[derive(Default)]
    pub struct Column {
        pub width: Cell<i32>,
    }

    #[glib::object_subclass]
    impl ObjectSubclass for Column {
        const NAME: &'static str = "AgentRelayColumn";
        type Type = super::Column;
        type ParentType = gtk::Widget;
    }

    impl ObjectImpl for Column {
        fn dispose(&self) {
            while let Some(child) = self.obj().first_child() {
                child.unparent();
            }
        }
    }

    impl WidgetImpl for Column {
        fn request_mode(&self) -> gtk::SizeRequestMode {
            gtk::SizeRequestMode::HeightForWidth
        }

        fn measure(&self, orientation: gtk::Orientation, for_size: i32) -> (i32, i32, i32, i32) {
            let Some(child) = self.obj().first_child() else {
                return (0, 0, -1, -1);
            };
            let width = self.width.get();
            if orientation == gtk::Orientation::Horizontal {
                let (minimum, natural, _, _) = child.measure(orientation, for_size);
                (minimum, natural.min(width).max(minimum), -1, -1)
            } else {
                let for_width = if for_size < 0 {
                    -1
                } else {
                    for_size.min(width)
                };
                let (minimum, natural, _, _) = child.measure(orientation, for_width);
                (minimum, natural, -1, -1)
            }
        }

        fn size_allocate(&self, width: i32, height: i32, baseline: i32) {
            if let Some(child) = self.obj().first_child() {
                let (minimum, _, _, _) = child.measure(gtk::Orientation::Horizontal, height);
                child.allocate(
                    width.min(self.width.get()).max(minimum),
                    height,
                    baseline,
                    None,
                );
            }
        }
    }
}

glib::wrapper! {
    /// Holds one child at most `width` wide, at the start of the space it
    /// gets, as the Mac's pages keep long rows readable on a wide window.
    pub struct Column(ObjectSubclass<column_imp::Column>)
        @extends gtk::Widget,
        @implements gtk::Buildable, gtk::ConstraintTarget;
}

impl Column {
    pub fn set_max_width(&self, width: i32) {
        if self.imp().width.replace(width) != width {
            self.queue_resize();
        }
    }

    pub fn new(width: i32, child: &impl IsA<gtk::Widget>) -> Column {
        let column: Column = glib::Object::new();
        column.imp().width.set(width);
        child.set_parent(&column);
        column
    }
}

mod sized_imp {
    use super::*;
    use std::cell::Cell;

    #[derive(Default)]
    pub struct Sized {
        pub size: Cell<(i32, i32)>,
    }

    #[glib::object_subclass]
    impl ObjectSubclass for Sized {
        const NAME: &'static str = "AgentRelaySized";
        type Type = super::Sized;
        type ParentType = gtk::Widget;
    }

    impl ObjectImpl for Sized {
        fn dispose(&self) {
            while let Some(child) = self.obj().first_child() {
                child.unparent();
            }
        }
    }

    impl WidgetImpl for Sized {
        fn measure(&self, orientation: gtk::Orientation, _for_size: i32) -> (i32, i32, i32, i32) {
            let (width, height) = self.size.get();
            let size = if orientation == gtk::Orientation::Horizontal {
                width
            } else {
                height
            };
            (size, size, -1, -1)
        }

        fn size_allocate(&self, width: i32, height: i32, baseline: i32) {
            if let Some(child) = self.obj().first_child() {
                child.allocate(width, height, baseline, None);
            }
        }
    }
}

glib::wrapper! {
    /// Holds one child at exactly `width` by `height` points, whatever the
    /// child's own size: a picture rasterized for the display's scale shows
    /// at its size in points.
    pub struct Sized(ObjectSubclass<sized_imp::Sized>)
        @extends gtk::Widget,
        @implements gtk::Buildable, gtk::ConstraintTarget;
}

impl Sized {
    pub fn new(width: i32, height: i32, child: &impl IsA<gtk::Widget>) -> Sized {
        let sized: Sized = glib::Object::new();
        sized.imp().size.set((width, height));
        child.set_parent(&sized);
        sized
    }
}

/// The display's scale: pictures are rasterized this many pixels per point.
fn display_scale() -> i32 {
    gdk::Display::default()
        .and_then(|display| display.monitors().item(0))
        .and_then(|monitor| monitor.downcast::<gdk::Monitor>().ok())
        .map(|monitor| monitor.scale_factor())
        .unwrap_or(1)
        .max(1)
}

/// A content column of at most `width`, padded as the pages are; children
/// go in the returned box.
pub fn column(width: i32) -> (gtk::Box, Column) {
    let inner = vbox(16, &[]);
    inner.set_margin_top(16);
    inner.set_margin_bottom(16);
    inner.set_margin_start(24);
    inner.set_margin_end(24);
    let holder = Column::new(width, &inner);
    (inner, holder)
}

/// A dot's color.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Color {
    Green,
    Orange,
    Accent,
    Grey,
}

impl Color {
    pub fn as_str(self) -> &'static str {
        match self {
            Color::Green => "green",
            Color::Orange => "orange",
            Color::Accent => "accent",
            Color::Grey => "grey",
        }
    }
}

/// A presence dot: filled or a ring, in green, orange, accent or grey.
/// Shape as well as color carries the state.
#[derive(Clone)]
pub struct Dot {
    pub widget: gtk::Box,
}

impl Dot {
    pub fn new(size: i32) -> Dot {
        let widget = hbox(0, &["dot"]);
        widget.set_size_request(size, size);
        widget.set_valign(gtk::Align::Center);
        widget.set_halign(gtk::Align::Center);
        Dot { widget }
    }

    pub fn colored(size: i32, color: Color) -> Dot {
        let dot = Dot::new(size);
        dot.set(Some(color), true);
        dot
    }

    /// No color hides the dot.
    pub fn set(&self, color: Option<Color>, filled: bool) {
        for color in [Color::Green, Color::Orange, Color::Accent, Color::Grey] {
            self.widget
                .remove_css_class(&format!("dot-{}", color.as_str()));
            self.widget
                .remove_css_class(&format!("ring-{}", color.as_str()));
        }
        if let Some(color) = color {
            let kind = if filled { "dot" } else { "ring" };
            self.widget
                .add_css_class(&format!("{kind}-{}", color.as_str()));
        }
        self.widget.set_visible(color.is_some());
    }

    /// The dot's current color class, for tests and accessibility.
    pub fn color(&self) -> Option<String> {
        self.widget.css_classes().iter().find_map(|class| {
            class
                .strip_prefix("dot-")
                .or_else(|| class.strip_prefix("ring-"))
                .map(str::to_owned)
        })
    }
}

/// A session's dot: green while messages push in, an orange ring while
/// connecting, a grey ring while the session isn't running, an accent ring
/// while joining, nothing off the relay.
pub fn presence_dot(presence: Presence) -> (Option<Color>, bool) {
    match presence {
        Presence::Online => (Some(Color::Green), true),
        Presence::Connecting => (Some(Color::Orange), false),
        Presence::Offline => (Some(Color::Grey), false),
        Presence::Joining => (Some(Color::Accent), false),
        Presence::Off | Presence::Leaving => (None, true),
    }
}

/// `widget` with `dot` in its bottom-end corner.
pub fn with_dot(widget: &impl IsA<gtk::Widget>, dot: &Dot) -> gtk::Overlay {
    let overlay = gtk::Overlay::new();
    overlay.set_child(Some(widget));
    dot.widget.set_halign(gtk::Align::End);
    dot.widget.set_valign(gtk::Align::End);
    overlay.add_overlay(&dot.widget);
    overlay.set_can_target(true);
    dot.widget.set_can_target(false);
    overlay
}

/// An SVG rasterized `width` by `height` pixels (`-1` keeps the aspect
/// ratio); `None` when the SVG loader is not installed.
pub fn raster(key: &str, data: &[u8], width: i32, height: i32) -> Option<gdk::Texture> {
    let tint = TEMPLATE_MARKS.contains(&key).then(|| color("secondary"));
    raster_tinted(key, data, width, height, tint)
}

/// [`raster`], with `currentColor` drawn in `tint` when one is given.
fn raster_tinted(
    key: &str,
    data: &[u8],
    width: i32,
    height: i32,
    tint: Option<&str>,
) -> Option<gdk::Texture> {
    let cache_key = (
        key.to_string(),
        width,
        height,
        tint.unwrap_or_default().to_string(),
    );
    if let Some(found) = RASTERS.with(|cache| cache.borrow().get(&cache_key).cloned()) {
        return found;
    }
    let data = if let Some(tint) = tint {
        String::from_utf8_lossy(data)
            .replace("currentColor", tint)
            .into_bytes()
    } else {
        data.to_vec()
    };
    let loader = gdk_pixbuf::PixbufLoader::new();
    loader.set_size(width, height);
    let texture = loader
        .write(&data)
        .and_then(|_| loader.close())
        .ok()
        .and_then(|_| loader.pixbuf())
        .map(|pixbuf| gdk::Texture::for_pixbuf(&pixbuf));
    RASTERS.with(|cache| cache.borrow_mut().insert(cache_key, texture.clone()));
    texture
}

/// Rasterizes an SVG's own aspect at `height` pixels: the loader's size
/// callback picks the width.
fn raster_at_height(key: &str, data: &[u8], height: i32) -> Option<gdk::Texture> {
    let loader = gdk_pixbuf::PixbufLoader::new();
    loader.write(data).ok()?;
    loader.close().ok()?;
    let pixbuf = loader.pixbuf()?;
    let width =
        (pixbuf.width() as f64 * height as f64 / pixbuf.height().max(1) as f64).round() as i32;
    raster(key, data, width.max(1), height)
}

/// An SVG `height` points tall at its own aspect, sharp at the display's
/// scale.
fn svg_picture(key: &str, data: &[u8], height: i32, accessible: &str) -> Option<Sized> {
    let scale = display_scale();
    let texture = raster_at_height(key, data, height * scale)?;
    let picture = gtk::Picture::for_paintable(&texture);
    picture.set_can_shrink(true);
    picture.set_alternative_text(Some(accessible));
    let sized = Sized::new(texture.width() / scale, height, &picture);
    sized.set_halign(gtk::Align::Start);
    sized.set_valign(gtk::Align::Center);
    sized.set_tooltip_text(Some(accessible));
    Some(sized)
}

/// The Agent Relay mark, `size` points square.
pub fn brand(size: i32) -> gtk::Widget {
    match svg_picture("agent-relay-mark", art::MARK, size, "Agent Relay") {
        Some(mark) => {
            mark.set_halign(gtk::Align::Center);
            mark.upcast()
        }
        None => text("Agent Relay", &["headline"]).upcast(),
    }
}

/// The agentrelay wordmark, `height` points tall; the name in text when the
/// SVG loader is missing.
pub fn wordmark(height: i32) -> gtk::Widget {
    match svg_picture("agent-relay-wordmark", art::WORDMARK, height, "Agent Relay") {
        Some(picture) => picture.upcast(),
        None => text("Agent Relay", &["headline"]).upcast(),
    }
}

/// Canonical mark and wordmark lockup for the shared application header.
pub fn header_brand() -> gtk::Box {
    let brand = hbox(10, &[]);
    brand.append(&self::brand(24));
    let tint = color("text");
    let data = String::from_utf8_lossy(art::WORDMARK).replace("#FFFFFF", tint);
    let key = format!("header-wordmark-{tint}");
    if let Some(wordmark) = svg_picture(&key, data.as_bytes(), 19, "Agent Relay") {
        brand.append(&wordmark);
    } else {
        brand.append(&text("Agent Relay", &["headline"]));
    }
    // The Mac's logo has no tooltip; its button is named "Sessions".
    let mut child = brand.first_child();
    while let Some(widget) = child {
        widget.set_has_tooltip(false);
        child = widget.next_sibling();
    }
    brand
}

/// The bundled mark for a harness or source name.
pub fn mark_file(source: &str) -> Option<&'static str> {
    Some(match source.to_lowercase().as_str() {
        "capy" => "capy",
        "codex" => "codex",
        "devin" => "devin",
        "openclaw" => "openclaw",
        "hermes" => "hermes",
        "claude" | "claude-code" | "claude_code" | "claudecode" => "claude",
        "grok" | "xai" => "grok",
        "cursor" | "cursor-cloud" | "cursor_cloud" => "cursor",
        "opencode" | "open-code" | "open_code" => "opencode",
        "openai" | "open-ai" | "open_ai" => "openai",
        "muse" | "muse-open" => "muse",
        "opencode-open" => "opencode",
        _ => return None,
    })
}

fn mark_label(mark: &str) -> &'static str {
    match mark {
        "capy" => "Capy",
        "codex" => "Codex",
        "devin" => "Devin",
        "openclaw" => "OpenClaw",
        "hermes" => "Hermes",
        "claude" => "Claude",
        "grok" => "Grok",
        "cursor" => "Cursor",
        "opencode" => "OpenCode",
        "openai" => "OpenAI",
        _ => "Muse",
    }
}

/// A harness badge: its mark in a rounded square when the app bundles one
/// (Capy, Codex, Claude, Devin, Grok, Cursor, OpenCode, OpenAI, Muse), else its
/// initials. The mark's widget is named `agent-mark-<name>`.
pub fn agent_badge(source: &str, size: i32) -> gtk::Widget {
    agent_badge_with_tint(source, size, None)
}

/// An explicit artwork tint, using the same theme-aware raster cache as badges.
pub fn agent_badge_with_tint(source: &str, size: i32, tint: Option<&str>) -> gtk::Widget {
    let inner = ((size as f64) * 0.62).round().max(8.0) as i32;
    harness_mark(
        source,
        size,
        inner,
        tint.unwrap_or("secondary"),
        "agent-icon",
    )
}

/// A harness badge with its hosting app in the top-end corner.
pub fn hosted_agent_badge(source: &str, size: i32, host: Option<&str>) -> gtk::Widget {
    let badge = agent_badge(source, size);
    if host != Some("paseo") {
        return badge;
    }
    let overlay = gtk::Overlay::new();
    overlay.set_child(Some(&badge));
    let side = ((size as f64) * 0.55).round().max(9.0) as i32;
    if let Some(texture) = raster(
        "host:paseo",
        art::PASEO,
        side * display_scale(),
        side * display_scale(),
    ) {
        let picture = gtk::Picture::for_paintable(&texture);
        picture.set_can_shrink(true);
        picture.set_size_request(side, side);
        picture.set_halign(gtk::Align::End);
        picture.set_valign(gtk::Align::Start);
        picture.set_tooltip_text(hosted_agent_tooltip(source, host).as_deref());
        overlay.add_overlay(&picture);
    }
    overlay.upcast()
}

fn hosted_agent_tooltip(source: &str, host: Option<&str>) -> Option<String> {
    (host == Some("paseo")).then(|| format!("{} in Paseo", source_name(source)))
}

/// A session table's harness tile, as the Mac's: a `size` rounded square
/// with the mark `inner` points across, a template mark in the text color.
pub fn agent_tile(source: &str, size: i32, inner: i32) -> gtk::Widget {
    harness_mark(source, size, inner, "text", "agent-tile")
}

fn harness_mark(source: &str, size: i32, inner: i32, tint: &str, class: &str) -> gtk::Widget {
    if let Some(mark) = mark_file(source) {
        let data = art::AGENT_MARKS
            .iter()
            .find(|(name, _)| *name == mark)
            .map(|(_, data)| *data)
            .unwrap_or_default();
        let scale = display_scale();
        let tint = TEMPLATE_MARKS.contains(&mark).then(|| {
            if tint.starts_with('#') || tint.starts_with("rgb") {
                tint
            } else {
                color(tint)
            }
        });
        if let Some(texture) = raster_tinted(mark, data, inner * scale, inner * scale, tint) {
            let holder = gtk::CenterBox::new();
            add_classes(&holder, &[class]);
            holder.set_size_request(size, size);
            holder.set_halign(gtk::Align::Center);
            holder.set_valign(gtk::Align::Center);
            let picture = gtk::Picture::for_paintable(&texture);
            picture.set_can_shrink(true);
            let sized = Sized::new(inner, inner, &picture);
            sized.set_valign(gtk::Align::Center);
            holder.set_center_widget(Some(&sized));
            let label = mark_label(mark);
            holder.set_tooltip_text(Some(label));
            name(&holder, label);
            holder.set_widget_name(&format!("agent-mark-{mark}"));
            return holder.upcast();
        }
    }
    let letters = match source.to_lowercase().as_str() {
        "gemini" => "Gm".to_string(),
        "devin" => "Dv".to_string(),
        "human" => "◉".to_string(),
        "service" => "⚙".to_string(),
        "agent" => "✦".to_string(),
        _ => {
            let mut letters: String = source.chars().take(2).collect();
            if let Some(first) = letters.chars().next() {
                letters = first
                    .to_uppercase()
                    .chain(letters.chars().skip(1).flat_map(char::to_lowercase))
                    .collect();
            }
            if letters.is_empty() {
                "?".into()
            } else {
                letters
            }
        }
    };
    let label = gtk::Label::new(Some(&letters));
    add_classes(&label, &[class]);
    label.set_size_request(size, size);
    label.upcast()
}

/// A single-color glyph from [`art::GLYPHS`], `size` points square in the
/// drawn theme's color `color_name`; an empty square when it can't be drawn.
pub fn glyph(glyph: &str, size: i32, color_name: &str) -> gtk::Widget {
    let data = art::GLYPHS
        .iter()
        .find(|(name, _)| *name == glyph)
        .map(|(_, data)| *data)
        .unwrap_or_default();
    let scale = display_scale();
    let key = format!("glyph:{glyph}");
    match raster_tinted(
        &key,
        data,
        size * scale,
        size * scale,
        Some(color(color_name)),
    ) {
        Some(texture) => {
            let picture = gtk::Picture::for_paintable(&texture);
            picture.set_can_shrink(true);
            let sized = Sized::new(size, size, &picture);
            sized.set_valign(gtk::Align::Center);
            sized.upcast()
        }
        None => {
            let empty = gtk::Box::new(gtk::Orientation::Horizontal, 0);
            empty.set_size_request(size, size);
            empty.upcast()
        }
    }
}

mod upload_activity_imp {
    use super::*;

    #[derive(Default)]
    pub struct UploadActivityIcon {
        pub size: Cell<i32>,
        pub elapsed: Cell<f64>,
        pub base: RefCell<Option<gdk::Texture>>,
        pub accent: RefCell<Option<gdk::Texture>>,
    }

    #[glib::object_subclass]
    impl ObjectSubclass for UploadActivityIcon {
        const NAME: &'static str = "AgentRelayUploadActivityIcon";
        type Type = super::UploadActivityIcon;
        type ParentType = gtk::Widget;
    }

    impl ObjectImpl for UploadActivityIcon {}

    impl WidgetImpl for UploadActivityIcon {
        fn measure(&self, _: gtk::Orientation, _: i32) -> (i32, i32, i32, i32) {
            (self.size.get(), self.size.get(), -1, -1)
        }

        fn snapshot(&self, snapshot: &gtk::Snapshot) {
            let size = self.size.get() as f32;
            let bounds = gtk::graphene::Rect::new(0.0, 0.0, size, size);
            if let Some(base) = self.base.borrow().as_ref() {
                snapshot.push_opacity(0.35);
                snapshot.append_texture(base, &bounds);
                snapshot.pop();
            }
            let (fill, opacity) = crate::linux_app::models::upload_activity_frame(
                self.elapsed.get(),
                !self.obj().settings().is_gtk_enable_animations(),
            );
            if let Some(accent) = self.accent.borrow().as_ref() {
                let height = size * fill as f32;
                snapshot.push_clip(&gtk::graphene::Rect::new(0.0, size - height, size, height));
                snapshot.push_opacity(opacity);
                snapshot.append_texture(accent, &bounds);
                snapshot.pop();
                snapshot.pop();
            }
        }
    }
}

glib::wrapper! {
    pub struct UploadActivityIcon(ObjectSubclass<upload_activity_imp::UploadActivityIcon>)
        @extends gtk::Widget,
        @implements gtk::Buildable, gtk::ConstraintTarget;
}

/// Fill the upload arrow from bottom to top, then gently fade before repeating.
/// The frame clock stops driving an unmapped widget; the callback holds no widget
/// reference and dies with the row. Reduced motion displays a steady arrow.
pub fn upload_activity_icon(size: i32) -> UploadActivityIcon {
    let widget: UploadActivityIcon = glib::Object::new();
    widget.imp().size.set(size);
    widget.set_widget_name("session-upload-activity");
    widget.set_valign(gtk::Align::Center);
    let data = art::GLYPHS
        .iter()
        .find(|(name, _)| *name == "arrow.up.circle.fill")
        .unwrap()
        .1;
    let pixels = size * display_scale();
    *widget.imp().base.borrow_mut() = raster_tinted(
        "glyph:arrow.up.circle.fill",
        data,
        pixels,
        pixels,
        Some(color("secondary")),
    );
    *widget.imp().accent.borrow_mut() = raster_tinted(
        "glyph:arrow.up.circle.fill",
        data,
        pixels,
        pixels,
        Some(color("accent")),
    );
    let start = Cell::new(None);
    let last_enabled = Cell::new(None);
    widget.add_tick_callback(move |widget, clock| {
        let now = clock.frame_time();
        let since = *start.get().get_or_insert(now);
        start.set(Some(since));
        let enabled = widget.settings().is_gtk_enable_animations();
        widget.imp().elapsed.set((now - since) as f64 / 1_000_000.0);
        if enabled || last_enabled.get() != Some(enabled) {
            widget.queue_draw();
        }
        last_enabled.set(Some(enabled));
        glib::ControlFlow::Continue
    });
    widget
}

/// Avatars are at most 2 MiB.
const AVATAR_LIMIT: u64 = 2 * 1024 * 1024;

/// A person's picture (a public `https` image, such as the Gravatar URL the
/// core names), else their initials.
pub fn avatar(person_name: &str, url: Option<&str>, size: i32) -> gtk::Box {
    let holder = hbox(0, &[]);
    holder.set_size_request(size, size);
    holder.set_halign(gtk::Align::Center);
    holder.set_valign(gtk::Align::Center);
    holder.set_overflow(gtk::Overflow::Hidden);
    holder.add_css_class("avatar-picture");
    let fallback = gtk::Label::new(Some(&initials(if person_name.is_empty() {
        "?"
    } else {
        person_name
    })));
    add_classes(&fallback, &["avatar"]);
    fallback.set_size_request(size, size);
    let font = (size as f64 * 0.3).max(7.0) as i32;
    let attributes = gtk::pango::AttrList::new();
    attributes.insert(gtk::pango::AttrSize::new(font * gtk::pango::SCALE));
    attributes.insert(gtk::pango::AttrInt::new_weight(gtk::pango::Weight::Bold));
    fallback.set_attributes(Some(&attributes));
    holder.append(&fallback);
    let Some(url) = url
        .filter(|url| url.starts_with("https://") || url.starts_with("data:image/"))
        .map(str::to_owned)
    else {
        return holder;
    };
    let show = {
        let holder = holder.downgrade();
        move |texture: &gdk::Texture| {
            let Some(holder) = holder.upgrade() else {
                return;
            };
            clear(&holder);
            let picture = gtk::Picture::for_paintable(texture);
            picture.set_can_shrink(true);
            picture.set_keep_aspect_ratio(false);
            holder.append(&Sized::new(size, size, &picture));
        }
    };
    if let Some(texture) = AVATARS.with(|cache| cache.borrow().get(&url).cloned()) {
        show(&texture);
        return holder;
    }
    glib::spawn_future_local(async move {
        let fetched = {
            let url = url.clone();
            gtk::gio::spawn_blocking(move || fetch_avatar(&url)).await
        };
        let Ok(Some(bytes)) = fetched else {
            return;
        };
        let Ok(texture) = gdk::Texture::from_bytes(&glib::Bytes::from_owned(bytes)) else {
            return;
        };
        AVATARS.with(|cache| cache.borrow_mut().insert(url, texture.clone()));
        show(&texture);
    });
    holder
}

/// The picture's bytes, when it stays on `https` and fits the limit.
fn fetch_avatar(url: &str) -> Option<Vec<u8>> {
    use std::io::Read;
    if url.starts_with("data:image/") {
        use base64::Engine;
        let (header, data) = url.split_once(',')?;
        if ![
            "data:image/png;base64",
            "data:image/jpeg;base64",
            "data:image/webp;base64",
            "data:image/gif;base64",
        ]
        .contains(&header)
            || data.len() as u64 > AVATAR_LIMIT * 4 / 3 + 4
        {
            return None;
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data)
            .ok()?;
        return (bytes.len() as u64 <= AVATAR_LIMIT).then_some(bytes);
    }
    let response = ureq::get(url)
        .set("User-Agent", "AgentRelayDesktop")
        .timeout(Duration::from_secs(10))
        .call()
        .ok()?;
    if !response.get_url().starts_with("https://") {
        return None;
    }
    let mut data = Vec::new();
    response
        .into_reader()
        .take(AVATAR_LIMIT + 1)
        .read_to_end(&mut data)
        .ok()?;
    (data.len() as u64 <= AVATAR_LIMIT).then_some(data)
}

pub fn section_title(value: &str) -> gtk::Label {
    let label = text(value, &["section-title"]);
    label.set_margin_top(6);
    label.set_margin_bottom(4);
    label.set_margin_start(10);
    label.set_margin_end(10);
    label
}

/// What a sidebar row shows beside its title.
#[derive(Default)]
pub struct RowExtras {
    pub icon: Option<&'static str>,
    pub leading: Option<gtk::Widget>,
    pub selected: bool,
    pub count: Option<usize>,
    pub live: bool,
    pub badge: Option<&'static str>,
}

pub fn sidebar_row(title: &str, extras: RowExtras, on: impl Fn() + 'static) -> gtk::Button {
    let row = gtk::Button::new();
    action_cursor(&row);
    add_classes(
        &row,
        &["sidebar-row", if extras.selected { "selected" } else { "" }],
    );
    let content = hbox(9, &[]);
    if let Some(leading) = &extras.leading {
        content.append(leading);
    } else if let Some(icon_name) = extras.icon {
        content.append(&icon(icon_name, 16));
    }
    let title_label = text(title, &["row-title"]).ellipsized();
    title_label.set_hexpand(true);
    content.append(&title_label);
    if let Some(badge) = extras.badge {
        let indicator = Dot::colored(6, Color::Accent).widget;
        indicator.set_tooltip_text(Some(&format!("{badge} available")));
        name(&indicator, &format!("{badge} available"));
        content.append(&indicator);
    }
    if let Some(count) = extras.count {
        let counted = hbox(4, &[]);
        if extras.live {
            counted.append(&Dot::colored(5, Color::Green).widget);
        }
        counted.append(&text(&grouped(count), &["count"]));
        content.append(&counted);
    }
    row.set_child(Some(&content));
    row.connect_clicked(move |_| on());
    name(&row, title);
    row
}

/// `1,234`.
pub fn grouped(count: usize) -> String {
    let digits = count.to_string();
    let mut text = String::new();
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            text.push(',');
        }
        text.push(digit);
    }
    text
}

pub fn section_header(title: &str, detail: Option<&str>) -> gtk::Box {
    let row = hbox(8, &[]);
    row.set_margin_start(8);
    row.set_margin_end(8);
    row.append(&text(title, &["section-header"]));
    row.append(&spacer());
    if let Some(detail) = detail {
        row.append(&text(detail, &["section-detail"]));
    }
    row.set_size_request(-1, 26);
    row
}

pub fn empty_note(value: &str) -> gtk::Label {
    let label = text(value, &["empty-note"]).wrapped();
    label.set_margin_start(8);
    label.set_margin_end(8);
    label.set_margin_bottom(8);
    label
}

/// How a banner or notice reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tone {
    Ok,
    Warn,
    Error,
    Neutral,
}

impl Tone {
    fn class(self) -> &'static str {
        match self {
            Tone::Ok => "ok",
            Tone::Warn => "warn",
            Tone::Error => "error",
            Tone::Neutral => "secondary",
        }
    }
}

pub fn banner(message: &str, tone: Tone, action: Option<(&str, Callback)>) -> gtk::Box {
    let row = hbox(
        8,
        &[
            "banner",
            if tone == Tone::Neutral {
                "banner-neutral"
            } else {
                "banner-warn"
            },
        ],
    );
    let glyph = icon("dialog-warning-symbolic", 14);
    glyph.add_css_class(tone.class());
    row.append(&glyph);
    let words = text(message, &[]).wrapped();
    words.set_hexpand(true);
    row.append(&words);
    if let Some((label, on)) = action {
        let act = button(label, &[], on);
        act.set_valign(gtk::Align::Center);
        row.append(&act);
    }
    row
}

/// A titled group; rows go in the second box.
pub fn settings_section(title: &str, description: Option<&str>) -> (gtk::Box, gtk::Box) {
    let outer = vbox(10, &[]);
    let heading = vbox(3, &[]);
    heading.append(&text(title, &["settings-section-title"]));
    if let Some(description) = description {
        heading.append(&text(description, &["settings-section-description"]).wrapped());
    }
    outer.append(&heading);
    let group = vbox(0, &["settings-group"]);
    outer.append(&group);
    (outer, group)
}

pub fn settings_divider(group: &gtk::Box, inset: i32) {
    let line = gtk::Separator::new(gtk::Orientation::Horizontal);
    line.set_margin_start(inset);
    group.append(&line);
}

pub fn settings_icon(icon_name: &str) -> gtk::Widget {
    let holder = gtk::CenterBox::new();
    add_classes(&holder, &["settings-icon"]);
    holder.set_center_widget(Some(&icon(icon_name, 16)));
    holder.set_size_request(24, 28);
    holder.set_valign(gtk::Align::Start);
    holder.upcast()
}

/// Icon, title and detail, then `accessory` at the end. Returns the row and
/// its text column, for notices added later.
pub fn settings_row(
    title: &str,
    detail: &str,
    icon_name: &str,
    accessory: Option<&gtk::Widget>,
    extra: &[gtk::Widget],
) -> (gtk::Box, gtk::Box) {
    let row = hbox(14, &[]);
    pad(&row, 16, None, None);
    row.append(&settings_icon(icon_name));
    let words = vbox(4, &[]);
    words.set_hexpand(true);
    words.append(&text(title, &["settings-row-title"]).wrapped());
    if !detail.is_empty() {
        words.append(&text(detail, &["settings-row-detail"]).wrapped());
    }
    for widget in extra {
        words.append(widget);
    }
    row.append(&words);
    if let Some(accessory) = accessory {
        accessory.set_valign(gtk::Align::Start);
        row.append(accessory);
    }
    (row, words)
}

/// A one-line warning, error or confirmation under a row.
pub fn notice(value: &str, tone: Tone) -> gtk::Widget {
    let row = hbox(6, &[]);
    let glyph = icon(
        if tone == Tone::Ok {
            "emblem-ok-symbolic"
        } else {
            "dialog-warning-symbolic"
        },
        12,
    );
    glyph.add_css_class(tone.class());
    glyph.set_valign(gtk::Align::Start);
    row.append(&glyph);
    let words = text(value, &[tone.class(), "caption"]).wrapped();
    words.set_hexpand(true);
    row.append(&words);
    row.set_margin_top(2);
    row.upcast()
}

pub fn copy_to_clipboard(value: &str) {
    if let Some(display) = gdk::Display::default() {
        display.clipboard().set_text(value);
    }
}

/// The Mac's travelling wave of nine bars, animated while shown.
pub fn loading_bars() -> gtk::Box {
    loading_bars_scaled(1.0)
}

pub fn loading_bars_scaled(scale: f64) -> gtk::Box {
    let row = hbox((5.0 * scale).round() as i32, &[]);
    row.set_halign(gtk::Align::Center);
    row.set_size_request((88.0 * scale) as i32, (40.0 * scale) as i32);
    let bars: Vec<gtk::Box> = (0..9)
        .map(|_| {
            let bar = hbox(0, &["loading-bar"]);
            bar.set_valign(gtk::Align::Center);
            bar.set_size_request((4.0 * scale) as i32, (8.0 * scale) as i32);
            row.append(&bar);
            bar
        })
        .collect();
    let start = std::time::Instant::now();
    row.add_tick_callback(move |_, _| {
        let elapsed = start.elapsed().as_secs_f64();
        for (index, bar) in bars.iter().enumerate() {
            let phase = elapsed * 2.0 * std::f64::consts::PI / 1.8 - index as f64 * 0.55;
            let wave = ((phase.sin() + 1.0) / 2.0).powi(2);
            bar.set_size_request((4.0 * scale) as i32, ((8.0 + 24.0 * wave) * scale) as i32);
            bar.set_opacity(0.3 + 0.7 * wave);
        }
        glib::ControlFlow::Continue
    });
    row
}

/// A popover of flat buttons under `anchor`; `None` as an action draws an
/// insensitive line, `-` as a label a separator.
pub fn popup_menu(
    anchor: &impl IsA<gtk::Widget>,
    items: Vec<(&str, Option<Callback>)>,
) -> gtk::Popover {
    let popover = gtk::Popover::new();
    popover.set_parent(anchor);
    popover.set_has_arrow(false);
    let content = vbox(2, &[]);
    pad(&content, 6, None, None);
    for (label, action) in items {
        if label == "-" {
            content.append(&gtk::Separator::new(gtk::Orientation::Horizontal));
            continue;
        }
        let item = gtk::Button::with_label(label);
        action_cursor(&item);
        add_classes(&item, &["flat"]);
        if let Some(child) = item.child() {
            child.set_halign(gtk::Align::Start);
        }
        match action {
            Some(action) => {
                let popover = popover.downgrade();
                item.connect_clicked(move |_| {
                    if let Some(popover) = popover.upgrade() {
                        popover.popdown();
                    }
                    action();
                });
            }
            None => item.set_sensitive(false),
        }
        content.append(&item);
    }
    popover.set_child(Some(&content));
    unparent_when_closed(&popover);
    popover.popup();
    popover
}

/// Every label's text and every labelled button's label under `widget`,
/// in order: what a person reading the window sees.
pub fn labels(widget: &impl IsA<gtk::Widget>) -> Vec<String> {
    let mut found = Vec::new();
    walk(widget.upcast_ref(), &mut |item| {
        if let Some(label) = item.downcast_ref::<gtk::Label>() {
            found.push(label.text().to_string());
        }
    });
    found
}

/// Calls `visit` on `widget` and every descendant, depth first.
pub fn walk(widget: &gtk::Widget, visit: &mut dyn FnMut(&gtk::Widget)) {
    visit(widget);
    let mut child = widget.first_child();
    while let Some(item) = child {
        walk(&item, visit);
        child = item.next_sibling();
    }
}

/// The buttons under `widget` whose label (or a label inside) reads `label`.
pub fn buttons(widget: &impl IsA<gtk::Widget>, label: &str) -> Vec<gtk::Button> {
    let mut found = Vec::new();
    walk(widget.upcast_ref(), &mut |item| {
        if let Some(button) = item.downcast_ref::<gtk::Button>() {
            if labels(button).iter().any(|text| text == label) {
                found.push(button.clone());
            }
        }
    });
    found
}

#[cfg(test)]
mod tests {
    #[test]
    fn inline_workspace_avatar_images_are_bounded_and_typed() {
        let png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB1sAAAAASUVORK5CYII=";
        assert!(super::fetch_avatar(png).unwrap().starts_with(b"\x89PNG"));
        assert!(super::fetch_avatar("data:image/svg+xml;base64,PHN2Zz4=").is_none());
        assert!(super::fetch_avatar("data:image/png;base64,invalid!").is_none());
        assert!(super::fetch_avatar(&format!(
            "data:image/png;base64,{}",
            "A".repeat(super::AVATAR_LIMIT as usize * 2)
        ))
        .is_none());
    }

    use super::*;

    /// gdk-pixbuf recognizes an SVG only by how it starts: one opening with
    /// a comment (a license notice) is drawn as an empty box.
    #[test]
    fn every_bundled_glyph_and_mark_rasterizes() {
        for (name, data) in art::GLYPHS.iter().chain(art::AGENT_MARKS.iter()) {
            let tinted = String::from_utf8_lossy(data).replace("currentColor", "#ffffff");
            let loader = gdk_pixbuf::PixbufLoader::new();
            loader.set_size(32, 32);
            let loaded = loader
                .write(tinted.as_bytes())
                .and_then(|_| loader.close())
                .ok()
                .and_then(|_| loader.pixbuf());
            assert!(loaded.is_some(), "{name} does not rasterize");
        }
    }

    #[test]
    fn presence_dots_carry_state_in_shape_and_color() {
        assert_eq!(presence_dot(Presence::Online), (Some(Color::Green), true));
        assert_eq!(
            presence_dot(Presence::Connecting),
            (Some(Color::Orange), false)
        );
        assert_eq!(presence_dot(Presence::Off), (None, true));
    }

    #[test]
    fn marks_are_found_by_every_spelling() {
        assert_eq!(mark_file("Claude-Code"), Some("claude"));
        assert_eq!(mark_file("xai"), Some("grok"));
        assert_eq!(mark_file("Capy"), Some("capy"));
        assert_eq!(mark_file("cursor-cloud"), Some("cursor"));
        assert_eq!(mark_file("gemini"), None);
        assert_eq!(grouped(1234567), "1,234,567");
    }

    #[test]
    fn paseo_badge_tooltip_names_the_hosted_agent() {
        assert_eq!(
            hosted_agent_tooltip("codex", Some("paseo")).as_deref(),
            Some("Codex in Paseo")
        );
        assert_eq!(
            hosted_agent_tooltip("claude-code", Some("paseo")).as_deref(),
            Some("Claude Code in Paseo")
        );
        assert_eq!(
            hosted_agent_tooltip("grok", Some("paseo")).as_deref(),
            Some("Grok in Paseo")
        );
        assert_eq!(hosted_agent_tooltip("codex", None), None);
    }
}

/// Remove a closed manually-parented menu after GTK finishes its signal.
pub fn unparent_when_closed(popover: &gtk::Popover) {
    // The signal holds a weak reference to avoid a parent → popover → parent
    // cycle. Only the pending idle callback retains the closing menu's parent.
    let parent = popover.parent().map(|parent| parent.downgrade());
    popover.connect_closed(move |popover| {
        let Some(parent) = parent.as_ref().and_then(|parent| parent.upgrade()) else {
            return;
        };
        let popover = popover.clone();
        glib::idle_add_local_once(move || {
            if popover.parent().as_ref() == Some(&parent) {
                popover.unparent();
            }
        });
    });
}
