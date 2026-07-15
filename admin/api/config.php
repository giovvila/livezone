<?php
header('Content-Type: application/json');
$config=__DIR__.'/../../config/config.json';
if($_SERVER['REQUEST_METHOD']==='GET'){readfile($config);exit;}
if($_SERVER['REQUEST_METHOD']==='POST'){$d=file_get_contents('php://input');if(json_decode($d)===null && json_last_error()!=JSON_ERROR_NONE){http_response_code(400);echo json_encode(['ok'=>false]);exit;}file_put_contents($config,$d);echo json_encode(['ok'=>true]);}
