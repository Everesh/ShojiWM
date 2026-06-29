use serde::Deserialize;

/// Mirror of `COMPOSITOR.debug` from the TS runtime. Kept narrow on
/// purpose: this carries only debug toggles that need to flow back into the
/// compositor render path.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDebugConfigUpdate {
    #[serde(default)]
    pub fps_counter: bool,
}
