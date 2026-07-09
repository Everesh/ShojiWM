#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeWorkspaceConfigUpdate {
    #[serde(default)]
    pub groups: Vec<RuntimeWorkspaceGroupConfig>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeWorkspaceGroupConfig {
    pub id: String,
    #[serde(default)]
    pub outputs: Vec<String>,
    #[serde(default)]
    pub workspaces: Vec<RuntimeWorkspaceEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeWorkspaceEntry {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub coordinates: Vec<u32>,
    #[serde(default)]
    pub active: bool,
    #[serde(default)]
    pub urgent: bool,
    #[serde(default)]
    pub hidden: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeWorkspaceActivateRequestSnapshot {
    pub workspace_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
}
