/**
 * Open Electricity's design-system theme, copied verbatim from
 * https://github.com/opennem/openelectricity/blob/main/tailwind.config.js
 *
 * Copied rather than re-expressed as a Tailwind v4 `@theme` block on purpose:
 * re-syncing with upstream is then a `curl` and a diff, not a translation. It is
 * loaded by `src/styles/app.css` via `@config`, which is how v4 consumes a
 * v3-style config.
 *
 * Note this `theme` REPLACES Tailwind's defaults rather than extending them —
 * there is no `gray-500`, no `text-2xl` at 24px, no `md:` at 768px. The scales
 * below are the whole vocabulary.
 *
 * TWO LOCAL DEVIATIONS, both marked inline:
 *   1. `content` globs .tsx, not .svelte.
 *   2. plugins are ESM `import`s, not `require()` — this package is
 *      `"type": "module"`.
 * Everything else is upstream's, unchanged, including the quirks: `alert-yellow`
 * really is a magenta, and `red` is the brand brick red (#C74523), NOT the NEM
 * regional colour (#e34a33) it is easily mistaken for.
 */
import typography from '@tailwindcss/typography';
import forms from '@tailwindcss/forms';

/** @type {import('tailwindcss').Config} */
export default {
	// DEVIATION: upstream is SvelteKit; we are React.
	content: ['./src/**/*.{html,js,ts,tsx}'],
	safelist: [
		{
			pattern: /bg-*-*/
		}
	],
	theme: {
		fontFamily: {
			sans: ['DM Sans Variable', 'DM Sans', 'sans-serif'],
			space: ['Space Grotesk Variable', 'Space Grotesk', 'sans-serif'],
			mono: ['DM Mono', 'monospace']
		},
		screens: {
			sm: '640px',
			// The /facilities and /facility/[code] mobile↔desktop boundary — those
			// routes use `tablet:`/`max-tablet:` instead of `md:` so their mobile
			// layout ends at 768px rather than the site-wide 1024px md.
			tablet: '768px',
			md: '1024px',
			lg: '1440px',
			xl: '1920px'
		},
		container: {
			center: true,
			padding: {
				DEFAULT: '2.5rem',
				md: '4rem',
				lg: '10rem',
				xl: '24rem'
			}
		},
		fontSize: {
			DEFAULT: '1.6rem',
			xxxs: '0.8rem',
			xxs: '1rem',
			xs: '1.2rem',
			sm: '1.4rem',
			base: '1.6rem',
			lg: '2rem',
			xl: '2.4rem',
			'2xl': '2.8rem',
			'3xl': '3.6rem',
			'4xl': '4rem',
			'5xl': '4.4rem',
			'6xl': '4.8rem',
			'7xl': '5.2rem',
			'8xl': '5.6rem',
			'9xl': '6rem'
		},
		lineHeight: {
			DEFAULT: '1.5',
			xs: '1.6rem',
			sm: '1.8rem',
			base: '2rem',
			lg: '2.4rem',
			xl: '2.8rem',
			'2xl': '3.2rem',
			'3xl': '4rem',
			'4xl': '4.4rem',
			'5xl': '4.8rem',
			'6xl': '5.2rem',
			'7xl': '5.6rem',
			'8xl': '6rem',
			'9xl': '6.4rem',
			none: '1',
			tight: '98%',
			snug: '105%'
		},
		letterSpacing: {
			tightest: '-0.12rem',
			tighter: '-0.072rem',
			tight: '-0.048rem',
			normal: '0',
			'normal-wide': '0.014rem',
			wide: '0.016rem',
			wider: '0.063rem',
			widest: '0.15rem'
		},
		colors: {
			transparent: 'transparent',
			white: '#ffffff',
			black: '#000000',
			red: '#C74523',
			'dark-red': '#963F29',
			'dark-grey': '#353535',
			'mid-grey': '#6A6A6A',
			'mid-warm-grey': '#C6C6C6',
			'warm-grey': '#F1F0ED',
			'light-warm-grey': '#FAF9F6',
			'alert-yellow': '#EB1F70',
			'error-red': '#FA6060',
			'success-green': '#70D26E',

			/* Fuel techs */
			battery_charging: '#577CFF',
			battery_discharging: '#3245c9',
			bioenergy_biogas: '#4CB9B9',
			bioenergy_biomass: '#1D7A7A',
			coal_black: '#121212',
			coal_brown: '#744A26',
			distillate: '#E15C34',
			gas_ccgt: '#FDB462',
			gas_ocgt: '#FFCD96',
			gas_recip: '#F9DCBC',
			gas_steam: '#F48E1B',
			gas_wcmg: '#B46813',
			hydro: '#5EA0C0',
			pumps: '#88AFD0',
			solar_utility: '#FED500',
			solar_thermal: '#FDB200',
			solar_rooftop: '#FFF58D',
			wind: '#2C7629',
			nuclear: '#C75338',
			imports: '#521986',
			exports: '#927BAD',
			interconnector: '#7F7F7F',

			/* Fuel tech groups */
			bioenergy: '#1D7A7A',
			coal: '#25170C',
			gas: '#E87809',
			solar: '#FED500',
			renewables: '#52A972',
			fossils: '#594929',

			demand: '#6A6A6A'
		},

		extend: {}
	},
	// DEVIATION: ESM imports, not require() — this package is "type": "module".
	// (Upstream's `extend.backgroundImage.grain` is dropped: we ship no grain.svg.)
	plugins: [typography, forms]
};
