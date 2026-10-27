// Edit this file to change the product or stores. No credentials belong here.
const MODELS = [{
  part: "MK1F4LL/A",
  name: "256GB Night Sky",
  buy: "https://www.apple.com/shop/buy-iphone/iphone-duo/7.6-inch-display-256gb-night-sky-unlocked",
}];

// One Bellevue search covered all seven stores when verified on October 27, 2026.
// Regional searches are used only when the primary response leaves a target unknown.
const PRIMARY_ZIP = "98004";
const STORE_CONFIG = [
  { id: "R003", name: "Bellevue Square", city: "Bellevue", zip: "98004" },
  { id: "R100", name: "Alderwood", city: "Lynnwood", zip: "98004" },
  { id: "R072", name: "University Village", city: "Seattle", zip: "98004" },
  { id: "R420", name: "River Park Square", city: "Spokane", zip: "99201" },
  { id: "R339", name: "Tacoma Mall", city: "Tacoma", zip: "98409" },
  { id: "R106", name: "Southcenter", city: "Tukwila", zip: "98004" },
  { id: "R077", name: "Pioneer Place", city: "Portland", zip: "97204" },
];
module.exports = { MODELS, PRIMARY_ZIP, STORE_CONFIG };
