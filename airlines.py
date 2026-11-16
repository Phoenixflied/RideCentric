"""Airline codes used to read flight numbers and to ask the flight service for the right code.

Flights on a manifest are written with the carrier's 2-character IATA code ("OO 5131", "9E 4701", "CX 0870").
Flight services often know the same flight under the 3-letter ICAO code ("SKW5131", "EDV4701", "CPA870"),
and regional flights are sold under a big airline's code ("DL 5131" flown by SkyWest). This table lets the
lookup try every form instead of giving up when the first one is not found.
"""

# IATA, ICAO, name
_TABLE = [
    # --- regional airlines that fly under Delta / American / United / Alaska names ---
    ("OO", "SKW", "SkyWest Airlines"), ("9E", "EDV", "Endeavor Air"), ("YX", "RPA", "Republic Airways"),
    ("MQ", "ENY", "Envoy Air"), ("OH", "JIA", "PSA Airlines"), ("PT", "PDT", "Piedmont Airlines"),
    ("YV", "ASH", "Mesa Airlines"), ("G7", "GJS", "GoJet Airlines"), ("C5", "UCA", "CommuteAir"),
    ("QX", "QXE", "Horizon Air"), ("ZW", "AWI", "Air Wisconsin"), ("CP", "CPZ", "Compass Airlines"),
    ("EV", "ASQ", "ExpressJet"), ("9K", "KAP", "Cape Air"),
    # --- US mainline ---
    ("AA", "AAL", "American Airlines"), ("DL", "DAL", "Delta Air Lines"), ("UA", "UAL", "United Airlines"),
    ("WN", "SWA", "Southwest Airlines"), ("AS", "ASA", "Alaska Airlines"), ("B6", "JBU", "JetBlue"),
    ("NK", "NKS", "Spirit Airlines"), ("F9", "FFT", "Frontier Airlines"), ("G4", "AAY", "Allegiant Air"),
    ("SY", "SCX", "Sun Country Airlines"), ("HA", "HAL", "Hawaiian Airlines"),
    # --- cargo ---
    ("5X", "UPS", "UPS Airlines"), ("FX", "FDX", "FedEx Express"), ("5Y", "GTI", "Atlas Air"), ("K4", "CKS", "Kalitta Air"),
    # --- Canada / Latin America ---
    ("AC", "ACA", "Air Canada"), ("WS", "WJA", "WestJet"), ("AM", "AMX", "Aeromexico"), ("Y4", "VOI", "Volaris"),
    ("VB", "VIV", "Viva Aerobus"), ("AV", "AVA", "Avianca"), ("LA", "LAN", "LATAM Airlines"), ("CM", "CMP", "Copa Airlines"),
    # --- Europe / Middle East / Asia / Pacific ---
    ("AF", "AFR", "Air France"), ("BF", "FBU", "French Bee"), ("BA", "BAW", "British Airways"), ("VS", "VIR", "Virgin Atlantic"),
    ("LH", "DLH", "Lufthansa"), ("KL", "KLM", "KLM"), ("IB", "IBE", "Iberia"), ("TP", "TAP", "TAP Air Portugal"),
    ("TB", "JAF", "TUI fly Belgium"), ("LX", "SWR", "Swiss"), ("EI", "EIN", "Aer Lingus"), ("AZ", "ITY", "ITA Airways"),
    ("QR", "QTR", "Qatar Airways"), ("EK", "UAE", "Emirates"), ("EY", "ETD", "Etihad Airways"), ("TK", "THY", "Turkish Airlines"),
    ("CX", "CPA", "Cathay Pacific"), ("JL", "JAL", "Japan Airlines"), ("NH", "ANA", "ANA"), ("KE", "KAL", "Korean Air"),
    ("SQ", "SIA", "Singapore Airlines"), ("BR", "EVA", "EVA Air"), ("CI", "CAL", "China Airlines"), ("QF", "QFA", "Qantas"),
    ("NZ", "ANZ", "Air New Zealand"), ("AI", "AIC", "Air India"),
]

BY_IATA = {i: (c, n) for i, c, n in _TABLE}
BY_ICAO = {c: (i, n) for i, c, n in _TABLE}

# Big airlines whose smaller regional partners may fly their flight numbers (the number is the same, the operator differs).
PARTNER_OPERATORS = {
    "DL": ["9E", "OO", "YX"],
    "AA": ["OO", "YX", "MQ", "OH", "PT"],
    "UA": ["OO", "YX", "C5", "G7"],
    "AS": ["QX", "OO"],
}


def icao_of(iata):
    return BY_IATA.get(iata, (None, None))[0]


def iata_of(icao):
    return BY_ICAO.get(icao, (None, None))[0]


def name_of(code):
    code = (code or "").upper()
    return (BY_IATA.get(code) or (None, None))[1] or (BY_ICAO.get(code) or (None, None))[1] or ""
