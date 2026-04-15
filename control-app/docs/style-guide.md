# Control Center Style Guide (v0.1)

## 1. Visual Direction

Theme goal: smooth, intuitive, dark-mode-first interface with cool dark green and blue foundations, plus controlled dark red accents for critical or in-progress states.

Design mood:

- Calm and focused
- Low-glare surfaces
- High legibility
- Fast visual scanning

## 2. Color Tokens

Core backgrounds:

- `--bg-primary: #081114`
- `--bg-secondary: #0d1b20`
- `--bg-panel: #11242b`
- `--bg-panel-soft: #142f38`

Primary text:

- `--text-primary: #e6f7fb`
- `--text-secondary: #9eb7be`

Accent palette:

- `--accent-cyan: #3ac2d4`
- `--accent-blue: #3d86c5`
- `--accent-red: #9f2d37`

Status colors:

- Ready: green-teal family
- WIP and caution: dark red family

## 3. Typography

Preferred stack:

- "Segoe UI", "Trebuchet MS", sans-serif

Usage:

- Section headings: medium-bold with slightly increased letter spacing
- Body text: standard weight with strong contrast
- Metadata labels: smaller uppercase styles

## 4. Layout

Primary shell:

- Fixed left sidebar for navigation
- Flexible right content area for app views

Spacing:

- Use 8px rhythm for paddings, gaps, and margins

Containers:

- Rounded cards with subtle borders and shadow depth

## 5. Component Patterns

Tabs:

- Active tabs use stronger border and gradient emphasis
- Hover interactions should slide slightly to indicate direction and movement

Cards:

- Group related content into cards
- Keep one conceptual purpose per card

Badges:

- Use pill badges for mode indicators and status

## 6. Motion Guidelines

- Use short transitions between 150ms and 220ms
- Prefer fade + subtle slide for view transitions
- Avoid heavy animation or visual noise in core workflows

## 7. Accessibility

- Maintain clear contrast between text and backgrounds
- Do not encode status by color alone when possible
- Keep tap targets and click targets large enough for mobile and desktop input

## 8. Theming Rules

- Dark mode is the default and required baseline
- New components must use tokenized colors rather than hard-coded values
- Any app-specific visual variation should inherit the same core token system