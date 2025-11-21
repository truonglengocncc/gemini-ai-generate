## ADDED Requirements

### Requirement: Group-Based Organization
The system SHALL organize generated images into groups to maintain logical separation and organization.

#### Scenario: Create new group
- **WHEN** user wants to organize a set of image generations
- **THEN** system allows user to create a new group with a name
- **AND** system assigns unique identifier to the group
- **AND** system stores group metadata (name, createdAt, etc.)

#### Scenario: Generate images within group
- **WHEN** user creates or selects a group
- **AND** user submits image generation job
- **THEN** system associates all generated images with the selected group
- **AND** system stores images in group-specific storage location
- **AND** system maintains group-image relationships

#### Scenario: View group contents
- **WHEN** user selects a group
- **THEN** system displays all images generated within that group
- **AND** system shows group metadata (creation date, image count)
- **AND** system allows user to browse images within the group

### Requirement: Group Management API
The system SHALL provide API endpoints for creating, listing, and managing groups.

#### Scenario: Create group via API
- **WHEN** frontend calls `/api/groups` with POST request and group name
- **THEN** system creates new group record
- **AND** system returns group ID and metadata
- **AND** system initializes group storage location

#### Scenario: List groups via API
- **WHEN** frontend calls `/api/groups` with GET request
- **THEN** system returns list of all groups
- **AND** system includes group metadata (name, image count, createdAt)
- **AND** system orders groups by creation date (newest first)

#### Scenario: Get group details via API
- **WHEN** frontend calls `/api/groups/[id]` with GET request
- **THEN** system returns group details including all associated images
- **AND** system includes image metadata (prompts, generation date, etc.)

### Requirement: Bulk Download
The system SHALL allow users to download multiple images from a group as a ZIP file.

#### Scenario: Download group as ZIP
- **WHEN** user requests download for a group
- **THEN** system generates ZIP file containing all images in the group
- **AND** system includes image metadata (prompts, filenames) in ZIP
- **AND** system streams ZIP file to user's browser
- **AND** system provides download progress indicator

#### Scenario: Bulk select and download
- **WHEN** user selects multiple images from a group
- **THEN** system allows user to download selected images as ZIP
- **AND** system includes only selected images in ZIP file
- **AND** system maintains image organization within ZIP

#### Scenario: Download multiple groups
- **WHEN** user selects multiple groups for download
- **THEN** system creates ZIP file containing images from all selected groups
- **AND** system organizes images by group within ZIP structure
- **AND** system includes group names in ZIP directory structure

### Requirement: Image Storage Organization
The system SHALL store generated images in an organized structure that reflects group membership.

#### Scenario: Store images by group
- **WHEN** images are generated for a specific group
- **THEN** system stores images in group-specific directory structure
- **AND** system uses group ID in storage path
- **AND** system maintains image metadata (prompt, reference image, timestamp)

#### Scenario: Maintain image-group relationships
- **WHEN** image is generated
- **THEN** system records image-group relationship in data store
- **AND** system enables efficient querying of images by group
- **AND** system supports bulk operations on group images

