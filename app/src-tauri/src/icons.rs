//! The five tray icons, generated from the one that ships.
//!
//! Not five hand drawn files. One source image, decoded once at startup, with a
//! mark composited in Rust. That keeps the five states impossible to get out of
//! sync with each other, and it keeps the icon a designer replaces down to
//! exactly one file.
//!
//! What makes a badge legible at 16 logical pixels, which is what Windows
//! actually draws:
//!
//!   * **Size.** The dot is a bit over a quarter of the icon's width. Anything
//!     subtler is a smudge at 16px and invisible at 100 percent scaling.
//!   * **A transparent moat.** The badge is not outlined, it is punched out of
//!     the artwork underneath and then filled. An outline has to pick a colour
//!     that works on both a light and a dark taskbar and there is no such
//!     colour; a hole works on every background there is.
//!   * **Colour, not shape.** At this size a person reads hue before they read
//!     form, so delivering is green and attention is amber and broken is red,
//!     and the difference survives being three millimetres wide.
//!
//! **Why there is a red at all.** Amber was carrying two jobs. A quota hold
//! until midnight comes back by itself and wants nothing from anybody; an engine
//! that will not start until somebody signs in delivers nothing until they do.
//! Those ask a person for opposite things, so they may not wear one dot. Amber is
//! now held, and red is "nothing will deliver until you act".
//!
//! Paused is the one state that is not a badge, and it is not only a dimming
//! either. The artwork is desaturated and dimmed, because
//! "nothing is happening" should read as the artwork stepping back rather than as
//! one more dot to interpret, and then it wears a hollow ring in the badge's own
//! corner, because on a walk of the built icons the dimming alone was too quiet
//! to read as a state.
//!
//! **A pause glyph was considered and rejected**, on the
//! third bullet above: at this size hue survives and form does not, so two
//! upright bars are a smudge with a meaning nobody can reach. A ring is not a
//! glyph. It is the badge's own silhouette with the middle taken out, which is a
//! difference a person reads at the size they already read a dot at.
//!
//! No animation. TRAY-DESIGN section 3: a spinning tray icon reads as spam.

use tauri::image::Image;

use crate::state::IconState;

/// The one file every variant is made from.
const SOURCE_PNG: &[u8] = include_bytes!("../icons/32x32.png");

/// Badge radius as a fraction of the icon's width.
const BADGE_RADIUS: f32 = 0.28;
/// Transparent gap between the artwork and the badge, in fractions of width.
const MOAT: f32 = 0.06;
/// Samples per axis when working out how much of a pixel the disc covers.
const SUPERSAMPLE: u32 = 4;

/// The paused ring's inner edge, as a fraction of the badge radius it borrows.
///
/// Half, which leaves a band a shade over two pixels wide once Windows has halved
/// the 32 pixel source, with a hole about four across inside it. Thinner and the
/// hole closes up at 16px and the ring is a dot, which is the one thing it exists
/// not to be.
const RING_HOLE: f32 = 0.5;

/// Delivering: a calm green. Not a warning colour, because nothing is wrong.
const GREEN: [u8; 3] = [0x2f, 0xa8, 0x4f];
/// Attention: amber. Warning enough to notice, not red enough to alarm.
const AMBER: [u8; 3] = [0xf5, 0xa5, 0x24];
/// Broken: red, and heavier than the amber it has to be told apart from, because
/// at three millimetres weight lands before hue finishes arriving.
const RED: [u8; 3] = [0xd9, 0x2d, 0x20];

/// Paused: mid grey, the one value the desaturation is already pulling the
/// artwork towards.
///
/// The header's second bullet says an outline cannot pick a colour that works on
/// both taskbars, and it is right about outlines: an outline has to be told apart
/// from two things at once, the artwork it rings and the taskbar behind it. The
/// ring has one of those jobs, because the moat has already taken the artwork out
/// from under it, so the only question left is whether it reads on a taskbar. Mid
/// grey reads on either: 3.6 to 1 against Windows' light taskbar and 4.1 to 1
/// against its dark one, both past the 3 to 1 floor a graphical mark needs, and
/// `the_paused_ring_reads_on_both_a_light_and_a_dark_taskbar` holds those numbers
/// rather than leaving them to this sentence.
///
/// It is also deliberately not a hue. **Paused is not a severity and must not
/// borrow one of the three colours that are**, which is the same reason the grey
/// icon has always meant a person and never a problem.
const RING: [u8; 3] = [0x80, 0x80, 0x80];

/// All five, decoded and composited once.
pub struct Icons {
    idle: Image<'static>,
    delivering: Image<'static>,
    paused: Image<'static>,
    attention: Image<'static>,
    broken: Image<'static>,
}

impl Icons {
    /// Build the set. Fails only if the bundled PNG cannot be decoded, which
    /// would mean the binary itself is wrong.
    pub fn build() -> Result<Self, String> {
        let base = Image::from_bytes(SOURCE_PNG)
            .map_err(|err| format!("the bundled tray icon did not decode: {err}"))?;
        let (width, height) = (base.width(), base.height());
        let rgba = base.rgba().to_vec();

        Ok(Self {
            idle: Image::new_owned(rgba.clone(), width, height),
            delivering: Image::new_owned(badged(&rgba, width, height, GREEN), width, height),
            attention: Image::new_owned(badged(&rgba, width, height, AMBER), width, height),
            broken: Image::new_owned(badged(&rgba, width, height, RED), width, height),
            // Greyed first and ringed second, so the mark is not desaturated
            // along with the artwork it is there to speak over. The ring also
            // keeps its own full opacity where the artwork drops to 65 percent,
            // which is what lets one mark be read on an icon whose whole point
            // is to be dim.
            paused: Image::new_owned(ringed(&greyed(&rgba), width, height, RING), width, height),
        })
    }

    /// The image for one state, and there is no wildcard arm on purpose: a sixth
    /// state should stop the build here rather than quietly wear the idle bird.
    pub fn for_state(&self, state: IconState) -> &Image<'static> {
        match state {
            IconState::Idle => &self.idle,
            IconState::Delivering => &self.delivering,
            IconState::Paused => &self.paused,
            IconState::Attention => &self.attention,
            IconState::Broken => &self.broken,
        }
    }
}

/// The filled dot the three coloured states wear.
fn badged(rgba: &[u8], width: u32, height: u32, colour: [u8; 3]) -> Vec<u8> {
    marked(rgba, width, height, colour, 0.0)
}

/// The hollow ring paused wears over its dimming.
fn ringed(rgba: &[u8], width: u32, height: u32, colour: [u8; 3]) -> Vec<u8> {
    marked(rgba, width, height, colour, RING_HOLE)
}

/// Punch a hole in the bottom right corner and paint a mark in it.
///
/// `inner` is the mark's own hole, as a fraction of the badge radius: zero is the
/// disc every badge is, and anything above it is a ring. **One function for both
/// because the corner, the size and the moat are one decision for both**, and two
/// copies of that decision is how the delivering dot and the paused ring would
/// eventually stop lining up. A person who has learned where to look for one mark
/// has learned where to look for the other.
///
/// The middle of a ring is left exactly as the moat made it, which is to say a
/// hole, on the same argument the moat itself rests on: a hole works on every
/// background there is, and a fill would be one more colour that had to survive
/// two taskbars.
fn marked(rgba: &[u8], width: u32, height: u32, colour: [u8; 3], inner: f32) -> Vec<u8> {
    let mut out = rgba.to_vec();
    let w = width as f32;
    let radius = w * BADGE_RADIUS;
    let moat = w * MOAT;
    // Sat just inside the corner so the mark is never clipped by the icon edge.
    let cx = w - radius - moat * 0.5;
    let cy = height as f32 - radius - moat * 0.5;

    for y in 0..height {
        for x in 0..width {
            let index = ((y * width + x) * 4) as usize;
            if index + 3 >= out.len() {
                continue;
            }

            // The moat first: whatever is under the mark and its gap goes.
            let hole = coverage(x, y, cx, cy, radius + moat);
            if hole > 0.0 {
                let keep = 1.0 - hole;
                out[index + 3] = (out[index + 3] as f32 * keep).round() as u8;
            }

            // Then the mark itself, over the hole. Subtracting the inner disc is
            // what turns a dot into a ring, and it costs nothing in sharpness:
            // both edges come out antialiased by the same supersampling, because
            // both are read from the same coverage.
            let fill = coverage(x, y, cx, cy, radius) - coverage(x, y, cx, cy, radius * inner);
            if fill > 0.0 {
                over(&mut out[index..index + 4], colour, fill);
            }
        }
    }
    out
}

/// How much of pixel (x, y) falls inside the disc, 0.0 to 1.0. Supersampled,
/// which is what stops a 32 pixel circle from looking like a staircase once
/// Windows scales it down to 16.
fn coverage(x: u32, y: u32, cx: f32, cy: f32, radius: f32) -> f32 {
    let mut hits = 0u32;
    let step = 1.0 / SUPERSAMPLE as f32;
    for sy in 0..SUPERSAMPLE {
        for sx in 0..SUPERSAMPLE {
            let px = x as f32 + (sx as f32 + 0.5) * step;
            let py = y as f32 + (sy as f32 + 0.5) * step;
            let dx = px - cx;
            let dy = py - cy;
            if dx * dx + dy * dy <= radius * radius {
                hits += 1;
            }
        }
    }
    hits as f32 / (SUPERSAMPLE * SUPERSAMPLE) as f32
}

/// Straight alpha source over destination. The PNG decode is not
/// premultiplied and the tray backend does its own premultiplication, so this
/// stays in straight alpha the whole way.
fn over(pixel: &mut [u8], colour: [u8; 3], alpha: f32) {
    let src_a = alpha.clamp(0.0, 1.0);
    let dst_a = pixel[3] as f32 / 255.0;
    let out_a = src_a + dst_a * (1.0 - src_a);
    if out_a <= 0.0 {
        pixel.copy_from_slice(&[0, 0, 0, 0]);
        return;
    }
    for channel in 0..3 {
        let src = colour[channel] as f32;
        let dst = pixel[channel] as f32;
        let value = (src * src_a + dst * dst_a * (1.0 - src_a)) / out_a;
        pixel[channel] = value.round().clamp(0.0, 255.0) as u8;
    }
    pixel[3] = (out_a * 255.0).round().clamp(0.0, 255.0) as u8;
}

/// Desaturate and dim: the icon stepping back rather than shouting.
fn greyed(rgba: &[u8]) -> Vec<u8> {
    let mut out = rgba.to_vec();
    for pixel in out.chunks_exact_mut(4) {
        let luminance = 0.299 * pixel[0] as f32 + 0.587 * pixel[1] as f32 + 0.114 * pixel[2] as f32;
        // Half way to mid grey, so the artwork keeps its shape and loses its
        // voice. Full flattening turns a tray icon into a blob.
        let flattened = (luminance * 0.5 + 128.0 * 0.5).round().clamp(0.0, 255.0) as u8;
        pixel[0] = flattened;
        pixel[1] = flattened;
        pixel[2] = flattened;
        pixel[3] = (pixel[3] as f32 * 0.65).round() as u8;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> (Vec<u8>, u32, u32) {
        let image = Image::from_bytes(SOURCE_PNG).expect("bundled icon decodes");
        (image.rgba().to_vec(), image.width(), image.height())
    }

    /// Every state there is, so a sweep covers the five rather than the four
    /// somebody remembered.
    const EVERY_STATE: [IconState; 5] = [
        IconState::Idle,
        IconState::Delivering,
        IconState::Paused,
        IconState::Attention,
        IconState::Broken,
    ];

    /// Where the mark sits, which every geometry test below has to agree with
    /// [`marked`] about. Centre, then the badge radius.
    fn mark_centre(width: u32, height: u32) -> (f32, f32, f32) {
        let w = width as f32;
        let radius = w * BADGE_RADIUS;
        let moat = w * MOAT;
        (
            w - radius - moat * 0.5,
            height as f32 - radius - moat * 0.5,
            radius,
        )
    }

    /// WCAG relative luminance. Here because this module makes exactly one claim
    /// that is a number, and a number in a doc comment nobody checks is a wish.
    fn luminance(colour: [u8; 3]) -> f64 {
        let channel = |value: u8| {
            let value = value as f64 / 255.0;
            if value <= 0.03928 {
                value / 12.92
            } else {
                ((value + 0.055) / 1.055).powf(2.4)
            }
        };
        0.2126 * channel(colour[0]) + 0.7152 * channel(colour[1]) + 0.0722 * channel(colour[2])
    }

    fn contrast(a: [u8; 3], b: [u8; 3]) -> f64 {
        let one = luminance(a);
        let other = luminance(b);
        (one.max(other) + 0.05) / (one.min(other) + 0.05)
    }

    #[test]
    fn the_bundled_icon_decodes_and_is_square() {
        let (rgba, width, height) = base();
        assert_eq!(width, height, "the tray source should be square");
        assert_eq!(rgba.len(), (width * height * 4) as usize);
    }

    #[test]
    fn all_five_variants_build() {
        let icons = Icons::build().expect("icons build");
        for state in EVERY_STATE {
            let image = icons.for_state(state);
            assert_eq!(image.width(), image.height());
            assert!(!image.rgba().is_empty());
        }
    }

    #[test]
    fn no_two_states_draw_the_same_icon() {
        // Five states, five pictures. A state that comes out byte for byte as
        // another one is a state a person cannot see, which is worse than not
        // having it: the state machine believes it is saying something.
        let icons = Icons::build().expect("icons build");
        for (index, one) in EVERY_STATE.iter().enumerate() {
            for other in &EVERY_STATE[index + 1..] {
                assert_ne!(
                    icons.for_state(*one).rgba(),
                    icons.for_state(*other).rgba(),
                    "{one:?} and {other:?} draw the same icon"
                );
            }
        }
    }

    #[test]
    fn the_badge_lands_in_the_bottom_right_and_nowhere_else() {
        let (rgba, width, height) = base();
        let (cx, cy, _radius) = mark_centre(width, height);
        let centre = ((cy as u32 * width + cx as u32) * 4) as usize;

        // Every dot, so the red one is held by the same rule as the two that
        // came before it rather than by a test of its own that could drift.
        for colour in [GREEN, AMBER, RED] {
            let badged = badged(&rgba, width, height, colour);
            // Dead centre of the badge is the badge colour.
            assert_eq!(&badged[centre..centre + 3], &colour[..]);
            assert_eq!(badged[centre + 3], 255);
            // The opposite corner is untouched artwork.
            assert_eq!(&badged[0..4], &rgba[0..4]);
        }
    }

    #[test]
    fn the_paused_ring_is_a_ring_and_lands_where_the_badge_lands() {
        // The paused rule, as geometry. Three claims: the
        // mark is in the badge's own corner, its middle is not filled, and it is
        // not dimmed along with the artwork it speaks over.
        let (rgba, width, height) = base();
        let grey = greyed(&rgba);
        let ringed = ringed(&grey, width, height, RING);
        let (cx, cy, radius) = mark_centre(width, height);

        // Halfway across the band, which is the ring itself.
        let band = radius * (1.0 + RING_HOLE) * 0.5;
        let on_ring = (((cy.round() as u32) * width + (cx - band).round() as u32) * 4) as usize;
        assert_eq!(&ringed[on_ring..on_ring + 3], &RING[..]);
        assert_eq!(
            ringed[on_ring + 3],
            255,
            "the ring took the artwork's dimming, which is what made paused too quiet"
        );

        // The middle belongs to the moat, so it is a hole and not a dot. This is
        // the assertion that fails if the ring is ever quietly made a disc again.
        let middle = (((cy.round() as u32) * width + cx.round() as u32) * 4) as usize;
        assert!(
            ringed[middle + 3] < 32,
            "the centre of the ring is filled at alpha {}, so it reads as a dot",
            ringed[middle + 3]
        );
        assert_ne!(&ringed[middle..middle + 3], &RING[..]);

        // And the opposite corner is the dimmed artwork, untouched.
        assert_eq!(&ringed[0..4], &grey[0..4]);
    }

    #[test]
    fn the_paused_ring_reads_on_both_a_light_and_a_dark_taskbar() {
        // Windows has no template image concept, so the mark has to hold on
        // whichever taskbar the machine is wearing. These are the two Windows
        // itself uses, and 3 to 1 is the floor for a graphical mark.
        const LIGHT_TASKBAR: [u8; 3] = [0xf3, 0xf3, 0xf3];
        const DARK_TASKBAR: [u8; 3] = [0x20, 0x20, 0x20];
        for taskbar in [LIGHT_TASKBAR, DARK_TASKBAR] {
            let ratio = contrast(RING, taskbar);
            assert!(
                ratio >= 3.0,
                "the ring is {ratio:.2} to 1 against {taskbar:?}, under the floor a mark needs"
            );
        }
        // And it is a neutral, because paused is not a severity and may not
        // borrow one of the three colours that are.
        assert_eq!(RING[0], RING[1]);
        assert_eq!(RING[1], RING[2]);
    }

    #[test]
    fn the_moat_really_is_transparent() {
        let (rgba, width, height) = base();
        let badged = badged(&rgba, width, height, GREEN);
        let w = width as f32;
        let radius = w * BADGE_RADIUS;
        let moat = w * MOAT;
        let cx = w - radius - moat * 0.5;
        let cy = height as f32 - radius - moat * 0.5;

        // A pixel between the badge edge and the moat edge.
        let probe_x = (cx - (radius + moat * 0.5)).round().max(0.0) as u32;
        let probe_y = cy.round() as u32;
        let index = ((probe_y * width + probe_x) * 4) as usize;
        let source_alpha = rgba[index + 3];
        assert!(
            badged[index + 3] < source_alpha,
            "the moat should knock the artwork back, got {} from {}",
            badged[index + 3],
            source_alpha
        );
    }

    #[test]
    fn the_three_severities_are_told_apart_by_colour() {
        let (rgba, width, height) = base();
        let green = badged(&rgba, width, height, GREEN);
        let amber = badged(&rgba, width, height, AMBER);
        let red = badged(&rgba, width, height, RED);
        assert_ne!(green, amber);
        assert_ne!(amber, red);
        assert_ne!(green, red);
        // And all three differ from the artwork they came from.
        assert_ne!(green, rgba);
        assert_ne!(red, rgba);
    }

    #[test]
    fn red_is_not_a_second_amber() {
        // The severity split is the whole point of the fifth state, and at three
        // millimetres a red that is only a warmer amber is one state wearing two
        // names. So red is both redder and heavier, and the weight is the half a
        // person reads first.
        assert!(
            luminance(RED) < luminance(AMBER),
            "red is not carrying more weight than amber"
        );
        let gap = |colour: [u8; 3]| colour[0] as i32 - colour[1] as i32;
        assert!(
            gap(RED) > gap(AMBER),
            "red is not further from amber's hue than amber is"
        );
    }

    #[test]
    fn paused_wears_a_mark_and_not_only_a_dimming() {
        // Walking the built icons showed it: the greyed bird on
        // its own is too quiet to read as a state at all. So paused carries a
        // mark as well, and this is the whole of that claim in one assertion,
        // which is that the composited icon is not simply the dimming.
        let (rgba, _width, _height) = base();
        let icons = Icons::build().expect("icons build");
        assert_ne!(
            icons.for_state(IconState::Paused).rgba(),
            greyed(&rgba).as_slice(),
            "paused is only the dimming, so nothing on it marks the state"
        );
    }

    #[test]
    fn paused_keeps_the_shape_and_loses_the_colour() {
        let (rgba, width, _height) = base();
        let grey = greyed(&rgba);
        assert_eq!(grey.len(), rgba.len());
        let _ = width;
        for pixel in grey.chunks_exact(4) {
            assert_eq!(pixel[0], pixel[1], "paused must be neutral");
            assert_eq!(pixel[1], pixel[2], "paused must be neutral");
        }
        // Dimmed, but still there: an invisible icon is not a state.
        let source_alpha: u64 = rgba.chunks_exact(4).map(|p| p[3] as u64).sum();
        let paused_alpha: u64 = grey.chunks_exact(4).map(|p| p[3] as u64).sum();
        assert!(paused_alpha < source_alpha);
        assert!(paused_alpha > source_alpha / 2);
    }

    #[test]
    fn the_ring_leaves_paused_neutral_all_the_way_through() {
        // The rule above, asked of the icon that ships rather than of the
        // function that dims it. It holds because the ring is grey, and it is the
        // assertion that fails the day somebody reaches for a colour here: a
        // paused pigeon wearing any hue at all is a state claiming to be a
        // problem, and the grey icon has always meant a person.
        let icons = Icons::build().expect("icons build");
        for pixel in icons.for_state(IconState::Paused).rgba().chunks_exact(4) {
            assert_eq!(pixel[0], pixel[1], "paused must be neutral");
            assert_eq!(pixel[1], pixel[2], "paused must be neutral");
        }
    }

    #[test]
    fn the_marks_are_big_enough_to_read_at_sixteen_pixels() {
        let (rgba, width, height) = base();
        let total = (width * height) as usize;
        let opaque = |p: &&[u8], colour: [u8; 3]| {
            p[0] == colour[0] && p[1] == colour[1] && p[2] == colour[2] && p[3] > 200
        };
        let painted = |image: &[u8], colour: [u8; 3]| {
            image.chunks_exact(4).filter(|p| opaque(p, colour)).count() * 100 / total
        };

        // Somewhere between a smudge and a takeover. At 32px source the dot is
        // roughly 9 pixels across, which survives the halving to 16.
        let dot = painted(&badged(&rgba, width, height, AMBER), AMBER);
        assert!(dot >= 4, "badge covers only {dot}% of the icon");
        assert!(
            dot <= 25,
            "badge covers {dot}% of the icon, which buries the artwork"
        );

        // The ring is the same silhouette with the middle out, so it paints less
        // and must still clear the smudge line. This is the number that says
        // whether `RING_HOLE` has been opened too far to leave a band.
        let ring = painted(&ringed(&greyed(&rgba), width, height, RING), RING);
        assert!(
            ring >= 3,
            "the ring covers only {ring}% of the icon, which is a hairline at 16px"
        );
        assert!(
            ring < dot,
            "the ring paints as much as the dot, so it has no hole"
        );
    }
}
