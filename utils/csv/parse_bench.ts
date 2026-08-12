import { parseCsvBytes } from './mod.ts'

const encoder = new TextEncoder()
const bytes = encoder.encode('Company,Website\nNorthstar,https://northstar.example\n')

Deno.bench('parseCsvBytes small CRM CSV', () => {
	parseCsvBytes(bytes)
})
