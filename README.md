<div align="center">
<img alt="banner" src="https://github.com/user-attachments/assets/9e05ab61-8a0f-4962-a8da-839f890908b2" width="100%" />
</div>

# Particle Spoilers
Particle Spoilers for Obsidian is a plugin that brings interactive spoiler effects right into your notes. It hides sensitive text, answers, or plot spoilers using your choice of three distinct styles: a dynamic animation of shimmering particles, a solid color block (similar to Discord or Steam), or a soft blur filter. The hidden text can be easily revealed with a simple click.

## Usage
Using the plugin is as simple as applying standard Markdown formatting or using the built-in commands.

- **Syntax:** to hide text, simply wrap it in your chosen marker, which defaults to double vertical bars `||`.
	- *Example:* `||This is a secret message||`.
- **Inserting:** you can easily wrap selected text by clicking the "eye-off" icon in the ribbon, or by using the "Insert spoiler" command in the command palette.
- **Settings:** go to the plugin settings to customize it to your liking:
    - **Spoiler style:** 
		- Particle (animated dust);
		- Block (solid color rectangle);
		- Blur (soft blur filter).
    - **Custom marker:** set a custom syntax marker (e.g., `!!`, `%%`) to avoid conflicts with other Markdown elements.
    - **Style Options:**
        - *Particle:* control the particle density and movement speed, and choose whether to use the app's accent color for the effect].
        - *Block:* choose between using the app's accent color or selecting a custom color via a color picker.
        - *Blur:* adjust the blur amount in pixels and optionally enable "Reveal on hover" to show the text without clicking.
    - **Hide on mouse leave:** the text will automatically close when you move your mouse away from the revealed spoiler.
    - **Disable effect in Edit mode:** choose whether the spoilers should be hidden in Live Preview, or only apply the effect in Reading mode.

#### Results

| Light Theme | Dark Theme |
| :---: | :---: |
<img alt="screen-particle-w" src="https://github.com/user-attachments/assets/b4288bfc-64b4-4cd0-80a6-5b419b921c4f" width="100%" /> | <img alt="screen-particle" src="https://github.com/user-attachments/assets/d1cf56a0-8cc7-40d8-a0fb-432576ced48b" width="100%" /> |
<img alt="screen-block-w" src="https://github.com/user-attachments/assets/184e56e1-8ca0-48f6-b283-38847d4bfe13" width="100%" /> | <img alt="screen-block" src="https://github.com/user-attachments/assets/29c05e36-ad49-4a8b-a7f8-01f37f05237d" width="100%" /> |
<img alt="screen-blur-w" src="https://github.com/user-attachments/assets/96e67c8d-f885-4e2a-a933-85f4d355e38a" width="100%" /> | <img alt="screen-blur" src="https://github.com/user-attachments/assets/d2689ca9-c543-4c94-bc0a-5e81dc32a67f" width="100%" /> |

<details>
  <summary>.gif (light theme demo)</summary>
  
  <img width="1023" height="722" alt="light theme demo" src="https://github.com/user-attachments/assets/d874ca9b-f230-497b-a1dd-8d47a18be585" />

</details>

<details>
  <summary>.gif (dark theme demo)</summary>

  <img width="1023" height="722" alt="dark theme demo" src="https://github.com/user-attachments/assets/5441cb7d-b493-497b-9747-877133a73abc" />
  

</details>

## Install

### Manually

1. Copy `main.js`, `manifest.json`, and `styles.css` into `<your vault>/.obsidian/plugins/particle-spoilers/`.
2. **Settings → Community plugins → Enable Particle Spoilers.**

### Upcoming features

- **Bulk reveal**: a new command will be added to the Obsidian command palette — "Reveal all spoilers in note", allowing you to open all hidden elements at once.
- **Per-note style customization**: support for your note's `cssclasses` property to apply a specific spoiler style, overriding the global settings.

#### Support

Particle Spoilers is free and open source. If it's useful to you, you can support its development with TON or USDT on the TON network: <kbd>tonproxywallet.ton</kbd> | <kbd>UQALKfbKI2Czizms4SisKXHnejG2iEoH26O-fy3_rJ5FbJDu</kbd>

**Thank you!**

---

License

MIT © LXXVII
