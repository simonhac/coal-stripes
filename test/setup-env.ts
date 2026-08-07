// Load .env.local so integration-style tests can reach OpenElectricity, matching
// what jest.setup.cjs did.
import { config } from 'dotenv';
config({ path: '.env.local' });
