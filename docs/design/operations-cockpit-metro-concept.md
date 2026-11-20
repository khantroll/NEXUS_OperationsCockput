# Operations Cockpit Metro Interface Concept

**Status:** Visual exploration  
**Reference image:** [Nexus Operations Cockpit Metro concept](../assets/nexus-operations-cockpit-metro-concept.jpg)

This concept responds to the desired direction for Nexus: a desktop operations workspace with the bold, flat tile language of Windows 8 Metro, adapted for active developer and remote-operation sessions. It is a design reference, not a final pixel specification or an assertion that every pictured integration exists.

## Design intent

- Treat Nexus as a live workspace for developer tools and remote sessions, not merely a launcher or generic metrics dashboard.
- Use a clear tile grid, strong color blocks, compact navigation, and high-contrast typography.
- Keep running tools visible as live workspace panels, with their own title bars and state indicators.
- Let users switch among distinct workspaces such as Conclave, Tank, and Home Lab.
- Keep parked windows accessible as individual items, and communicate that they remain live while parked.

## Per-window restore (SnapBack)

SnapBack is the behavior of an individual window returning to its saved position in the workspace. It is not a global command or a special master tile.

Each parked window should offer a direct, obvious way to bring that same window back to its remembered place. The decided interaction is double-click on that parked item as the primary restore gesture, with a per-tile Restore button (and a right-click context action) as the accessible secondary. Do not require a global “SnapBack” button or “restore all” control.

On restore, return the window to its saved workspace and position while preserving its live session when the underlying tool supports that. The UI should make clear which window is being restored and where it will return.

## Concept elements

- **Active workspace:** several visible, independently managed live windows.
- **Parked area:** individual parked window cards, each associated with its own restore interaction.
- **Workspace switcher:** distinct contexts for Conclave, Tank, and Home Lab, with compact status.
- **Metro visual language:** rectangular colored tiles, simple icons, strong hierarchy, and restrained live status.
- **Operational clarity:** running/parked state labels and recognizable window identity.

## Out of scope for this image

The concept does not settle M1 acceptance criteria, the exact window-management architecture, supported terminal/browser providers, or remote-access security. The UI should reflect verified product capability as implementation proceeds; illustrative content in the image is not evidence that a feature is already implemented.


## Implemented shell

The desktop shell now follows this concept's regions and restore gesture (double-click primary, per-tile Restore secondary). Workspace names come from the real registry; the pictured Conclave / Tank / Home Lab labels and Git / browser / VS Code tiles are illustrations, not seeded sample data. Live terminals fit and wrap with the xterm Fit addon, fill the canvas above a fixed bottom dock, and use Metro title-bar controls. A read-only REPO tile can show a local git tree, last-commit file list, and activity from an allow-listed main-process inspect of the workspace cwd. Remaining visual differences are listed in the visual-fidelity pull request.
