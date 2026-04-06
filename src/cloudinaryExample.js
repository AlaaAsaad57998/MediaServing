const url = "https://api.cloudinary.com/v1_1/djooohujg/upload";

const formData = new FormData();

// Fill in your own unsigned upload preset
formData.append("file", file);
formData.append("upload_preset", "v4h8xqns");
