// Standard lists people pick from (banks: RBI + Wikipedia list of banks in India; insurers: IRDAI-registered companies via Wikipedia;
// NPS pension funds: NPS Trust; brokers and fund platforms: common Indian apps). Anything missing can be added on the go;
// those additions live in the data file under "customLists" so they follow the user to every device.
const BANKS = [
  // Public sector
  'Bank of Baroda', 'Bank of India', 'Bank of Maharashtra', 'Canara Bank', 'Central Bank of India', 'Indian Bank', 'Indian Overseas Bank',
  'Punjab & Sind Bank', 'Punjab National Bank', 'State Bank of India', 'UCO Bank', 'Union Bank of India',
  // Private sector
  'Axis Bank', 'Bandhan Bank', 'City Union Bank', 'CSB Bank', 'DCB Bank', 'Dhanlaxmi Bank', 'Federal Bank', 'HDFC Bank', 'ICICI Bank', 'IDBI Bank',
  'IDFC First Bank', 'IndusInd Bank', 'Jammu & Kashmir Bank', 'Karnataka Bank', 'Karur Vysya Bank', 'Kotak Mahindra Bank', 'Nainital Bank', 'RBL Bank',
  'South Indian Bank', 'Tamilnad Mercantile Bank', 'Yes Bank',
  // Small finance banks
  'AU Small Finance Bank', 'Capital Small Finance Bank', 'Equitas Small Finance Bank', 'ESAF Small Finance Bank', 'Jana Small Finance Bank',
  'Shivalik Small Finance Bank', 'Suryoday Small Finance Bank', 'Ujjivan Small Finance Bank', 'Unity Small Finance Bank', 'Utkarsh Small Finance Bank',
  // Payments banks
  'Airtel Payments Bank', 'Fino Payments Bank', 'India Post Payments Bank', 'Jio Payments Bank', 'NSDL Payments Bank',
  // Post office
  'Post Office (India Post)',
  // Foreign banks in India
  'American Express Banking Corp', 'Bank of America', 'Barclays Bank', 'BNP Paribas', 'Citibank', 'Credit Agricole', 'DBS Bank India', 'Deutsche Bank',
  'Doha Bank', 'Emirates NBD', 'First Abu Dhabi Bank', 'HSBC', 'JPMorgan Chase Bank', 'Mizuho Bank', 'MUFG Bank', 'Qatar National Bank',
  'Shinhan Bank', 'Societe Generale', 'Standard Chartered Bank', 'Sumitomo Mitsui Banking Corporation', 'Woori Bank',
  // Large co-operative banks
  'Abhyudaya Co-operative Bank', 'Bharat Co-operative Bank', 'Cosmos Co-operative Bank', 'Janata Sahakari Bank', 'Kalupur Commercial Co-operative Bank',
  'NKGSB Co-operative Bank', 'Saraswat Co-operative Bank', 'SVC Co-operative Bank', 'TJSB Sahakari Bank',
];

const INSURERS = [
  // Life
  'Life Insurance Corporation of India (LIC)', 'HDFC Life', 'Axis Max Life', 'ICICI Prudential Life', 'Kotak Life', 'Aditya Birla Sun Life Insurance', 'Tata AIA Life',
  'SBI Life', 'Bajaj Allianz Life', 'PNB MetLife', 'Nippon Life India (Reliance Nippon Life)', 'Aviva Life', 'Sahara India Life', 'Shriram Life', 'Generali Central Life',
  'Ageas Federal Life', 'Canara HSBC Life', 'Bandhan Life', 'Pramerica Life', 'Star Union Dai-ichi Life', 'IndiaFirst Life', 'Edelweiss Life', 'Acko Life', 'Go Digit Life',
  // General and health
  'Acko General Insurance', 'Aditya Birla Health Insurance', 'Agriculture Insurance Company of India', 'Bajaj Allianz General', 'Care Health Insurance', 'Cholamandalam MS General',
  'ECGC', 'Galaxy Health Insurance', 'Generali Central General', 'Go Digit General Insurance', 'HDFC ERGO General', 'ICICI Lombard', 'IFFCO Tokio General', 'Kshema General Insurance',
  'Liberty General', 'Magma General', 'Manipal Cigna Health', 'National Insurance Company', 'Navi General Insurance', 'New India Assurance', 'Niva Bupa Health',
  'Raheja QBE General', 'Reliance General', 'Royal Sundaram General', 'SBI General', 'Shriram General', 'Star Health and Allied Insurance', 'Tata AIG General',
  'The Oriental Insurance Company', 'United India Insurance', 'Universal Sompo General', 'Zuno General Insurance', 'Zurich Kotak General',
];
const BROKERS = [
  '5paisa', 'Angel One', 'Anand Rathi', 'Axis Direct', 'Choice Broking', 'Dhan', 'Edelweiss (Nuvama)', 'Fyers', 'Geojit', 'Groww', 'HDFC Securities', 'ICICI Direct',
  'IIFL Securities', 'Kotak Securities', 'Motilal Oswal', 'Paytm Money', 'Religare Broking', 'SBI Securities', 'Sharekhan', 'Share India', 'Upstox', 'Zerodha',
];
const PLATFORMS = [
  'Angel One', 'Axis Direct', 'CAMS', 'Dhan', 'ET Money', 'Fisdom', 'Groww', 'HDFC Securities', 'ICICI Direct', 'INDmoney', 'KFintech', 'Kotak Securities', 'Kuvera',
  'MF Central', 'Motilal Oswal', 'Paytm Money', 'SBI Securities', 'Scripbox', 'Upstox', 'Zerodha Coin', 'Directly with the fund house (AMC)',
];
const PFMS = [
  'SBI Pension Funds', 'LIC Pension Fund', 'UTI Pension Fund', 'HDFC Pension Fund', 'ICICI Pension Fund', 'Kotak Mahindra Pension Fund',
  'Aditya Birla Sun Life Pension Fund', 'Tata Pension Fund', 'Axis Pension Fund', 'DSP Pension Fund',
];
const LISTS = { bank: BANKS, insurer: INSURERS, broker: BROKERS, platform: PLATFORMS, pfm: PFMS };
export const KIND_LABEL = { bank: 'bank', insurer: 'insurance company', broker: 'broker / demat account', platform: 'platform', pfm: 'pension fund manager', clientid: 'client ID / account' };
const norm = s => String(s || '').trim().toLowerCase();
/** Standard list + the entries this user added, sorted, no duplicates. */
export function optionList(kind, data) {
  const seen = new Map();
  const derived = kind === 'clientid' ? ((data && data.books) || []).flatMap(b => (b.brokerHoldings || []).map(x => x.accountId)).filter(Boolean) : [];
  [...(LISTS[kind] || []), ...derived, ...(((data && data.customLists) || {})[kind] || [])].forEach(n => { const k = norm(n); if (k && !seen.has(k)) seen.set(k, String(n).trim()); });
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}
export const sameName = (a, b) => norm(a) === norm(b);
