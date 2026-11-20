import { stateOfAddress } from './state-of-address';

describe('stateOfAddress', () => {
  it('reads the state from Indian addresses (the last one named wins), or null', () => {
    expect(stateOfAddress('Opp. Pasodya Vithoba Mandir, 437, Budhwar Peth, Pune, Maharashtra 411002')).toBe('Maharashtra');
    expect(stateOfAddress('Shop 4, M P Road, Mulund East, Mumbai, MAHARASHTRA 400081')).toBe('Maharashtra');
    expect(stateOfAddress('12 Kerala Street, Koramangala, Bengaluru, Karnataka 560034')).toBe('Karnataka');
    expect(stateOfAddress('MG Road, Kochi, Kerala 682016')).toBe('Kerala');
    expect(stateOfAddress('Bhubaneswar, Orissa')).toBe('Odisha');
    expect(stateOfAddress('Connaught Place, New Delhi 110001')).toBe('Delhi');
    expect(stateOfAddress('Somewhere 123')).toBeNull();
    expect(stateOfAddress(null)).toBeNull();
  });
});
